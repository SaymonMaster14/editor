/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { fft, nearestBeat, nextBeat, prevBeat, trackBeats } from './beats';

const SR = 48000;

/** Percussive click: 2 kHz sine under an exponential decay, ~40 ms. */
function click(sampleRate = SR): Float32Array {
	const frames = Math.floor(0.04 * sampleRate);
	const out = new Float32Array(frames);
	for (let i = 0; i < frames; i++) {
		out[i] = Math.sin((2 * Math.PI * 2000 * i) / sampleRate) * Math.exp(-i / (0.008 * sampleRate));
	}
	return out;
}

/** Clicks on the grid `bpm`, first at `offset`, `seconds` long. */
function clickTrack(bpm: number, seconds: number, offset = 0, sampleRate = SR): Float32Array {
	const out = new Float32Array(Math.floor(seconds * sampleRate));
	const tick = click(sampleRate);
	for (let beat = offset; beat < seconds; beat += 60 / bpm) {
		const at = Math.floor(beat * sampleRate);
		for (let i = 0; i < tick.length && at + i < out.length; i++) out[at + i]! += tick[i]!;
	}
	return out;
}

/** Every expected beat has a detected beat within `tolerance` seconds. */
function expectGridBeats(beats: number[], bpm: number, seconds: number, tolerance: number): void {
	for (let beat = 0; beat < seconds; beat += 60 / bpm) {
		const near = beats.some((found) => Math.abs(found - beat) <= tolerance);
		expect(near, `no beat near ${beat.toFixed(3)} in [${beats.map((b) => b.toFixed(3)).join(', ')}]`).toBe(true);
	}
}

describe('beats', () => {
	it('tracks a 120 BPM click track on the grid', () => {
		const grid = trackBeats([clickTrack(120, 8)], SR);
		expect(grid.bpm).toBeCloseTo(120, 0);
		expect(Math.abs(grid.bpm - 120)).toBeLessThan(1);
		expect(grid.beats.length).toBeGreaterThanOrEqual(15);
		expect(grid.beats.length).toBeLessThanOrEqual(17);
		expectGridBeats(grid.beats, 120, 8, 0.06);
		expect(grid.confidence).toBeGreaterThan(2);
	});

	it('tracks a 96 BPM click track starting off zero', () => {
		const grid = trackBeats([clickTrack(96, 8, 0.3)], SR);
		expect(Math.abs(grid.bpm - 96)).toBeLessThan(1);
		expectGridBeats(grid.beats.map((b) => b - 0.3), 96, 7.5, 0.06);
		expect(grid.confidence).toBeGreaterThan(2);
	});

	it('holds the quarter grid under eighth-note hats', () => {
		// Kick-ish thumps on quarters, quiet ticks on eighths: the tempo
		// is 100, not the 200 BPM subdivision the hats imply.
		const out = new Float32Array(8 * SR);
		const thump = click(SR);
		const tick = click(SR).map((v) => v * 0.3);
		for (let beat = 0; beat < 8; beat += 60 / 100) {
			const at = Math.floor(beat * SR);
			for (let i = 0; i < thump.length && at + i < out.length; i++) out[at + i]! += thump[i]!;
			const off = Math.floor((beat + 60 / 200) * SR);
			for (let i = 0; i < tick.length && off + i < out.length; i++) out[off + i]! += tick[i]!;
		}
		const grid = trackBeats([out], SR);
		expect(Math.abs(grid.bpm - 100)).toBeLessThan(1.5);
		expectGridBeats(grid.beats, 100, 8, 0.06);
	});

	it('finds onsets at the clicks', () => {
		const grid = trackBeats([clickTrack(120, 4)], SR);
		expect(grid.onsets.length).toBeGreaterThanOrEqual(7);
		expect(grid.onsets.length).toBeLessThanOrEqual(9);
		for (const onset of grid.onsets) {
			const phase = ((onset % 0.5) + 0.5) % 0.5;
			expect(Math.min(phase, 0.5 - phase)).toBeLessThan(0.06);
		}
	});

	it('returns an empty grid for silence', () => {
		const grid = trackBeats([new Float32Array(4 * SR)], SR);
		expect(grid).toEqual({ bpm: 0, beats: [], onsets: [], confidence: 0, durationSeconds: 4 });
	});

	it('returns an empty grid for a sustained tone with no attacks', () => {
		const tone = new Float32Array(5 * SR);
		for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
		const grid = trackBeats([tone], SR);
		expect(grid.bpm).toBe(0);
		expect(grid.beats).toEqual([]);
	});

	it('rejects empty input', () => {
		expect(() => trackBeats([], SR)).toThrow();
		expect(() => trackBeats([new Float32Array(100)], 0)).toThrow();
	});
});

describe('fft', () => {
	it('matches a naive DFT', () => {
		const n = 64;
		const real = new Float32Array(n);
		const imag = new Float32Array(n);
		for (let i = 0; i < n; i++) real[i] = Math.sin((2 * Math.PI * 3 * i) / n) + 0.5 * Math.cos((2 * Math.PI * 9 * i) / n);
		fft(real, imag);
		for (let k = 0; k < n; k++) {
			let dr = 0;
			let di = 0;
			for (let i = 0; i < n; i++) {
				const angle = (-2 * Math.PI * k * i) / n;
				const s = Math.sin((2 * Math.PI * 3 * i) / n) + 0.5 * Math.cos((2 * Math.PI * 9 * i) / n);
				dr += s * Math.cos(angle);
				di += s * Math.sin(angle);
			}
			expect(real[k]!).toBeCloseTo(dr, 2);
			expect(imag[k]!).toBeCloseTo(di, 2);
		}
	});
});

describe('beat helpers', () => {
	const beats = [0.5, 1.0, 1.5, 2.0];

	it('finds previous, next, and nearest beats', () => {
		expect(prevBeat(beats, 1.2)).toEqual({ index: 1, time: 1.0 });
		expect(prevBeat(beats, 1.0)).toEqual({ index: 1, time: 1.0 });
		expect(prevBeat(beats, 0.1)).toBeNull();
		expect(nextBeat(beats, 1.2)).toEqual({ index: 2, time: 1.5 });
		expect(nextBeat(beats, 1.5)).toEqual({ index: 2, time: 1.5 });
		expect(nextBeat(beats, 2.1)).toBeNull();
		expect(nearestBeat(beats, 1.2)).toEqual({ index: 1, time: 1.0 });
		expect(nearestBeat(beats, 1.3)).toEqual({ index: 2, time: 1.5 });
		expect(nearestBeat([], 1.0)).toBeNull();
	});
});
