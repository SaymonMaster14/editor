/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { LoudnessMeter, measureLoudness } from './loudness';

const SR = 48000;

/** Mono sine, peak amplitude `peak`, `seconds` long. */
function sine(freq: number, peak: number, seconds: number, sampleRate = SR): Float32Array {
	const frames = Math.floor(seconds * sampleRate);
	const out = new Float32Array(frames);
	for (let i = 0; i < frames; i++) out[i] = peak * Math.sin((2 * Math.PI * freq * i) / sampleRate);
	return out;
}

/** Raised-cosine edges over `edge` samples, so onsets don't Gibbs into peak readings. */
function faded(signal: Float32Array, sampleRate: number, edgeSeconds = 0.05): Float32Array {
	const edge = Math.floor(edgeSeconds * sampleRate);
	const out = Float32Array.from(signal);
	for (let i = 0; i < edge && i < out.length; i++) {
		const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / edge);
		out[i]! *= w;
		out[out.length - 1 - i]! *= w;
	}
	return out;
}

describe('loudness', () => {
	it('measures a 1 kHz sine at its RMS loudness', () => {
		// -20 dBFS peak sine → -23.01 dBFS RMS; the K-filter is ~flat at
		// 1 kHz, so integrated loudness lands within a few tenths of that.
		const tone = sine(1000, 10 ** (-20 / 20), 5);
		const result = measureLoudness([tone], SR);
		expect(result.integratedLUFS).toBeCloseTo(-23.0, 0);
		expect(Math.abs(result.integratedLUFS + 23.01)).toBeLessThan(0.4);
		expect(result.totalBlockCount).toBeGreaterThan(40);
		// Steady tone: no loudness range to speak of.
		expect(result.loudnessRangeLU).not.toBeNull();
		expect(result.loudnessRangeLU!).toBeLessThan(0.2);
	});

	it('sums stereo energy (+3.01 LU for dual mono)', () => {
		const tone = sine(1000, 10 ** (-20 / 20), 3);
		const mono = measureLoudness([tone], SR);
		const stereo = measureLoudness([tone, tone], SR);
		expect(stereo.integratedLUFS - mono.integratedLUFS).toBeCloseTo(3.0103, 2);
	});

	it('tracks level changes decibel for decibel', () => {
		const quiet = measureLoudness([sine(440, 0.1, 2)], SR);
		const loud = measureLoudness([sine(440, 0.4, 2)], SR);
		expect(loud.integratedLUFS - quiet.integratedLUFS).toBeCloseTo(20 * Math.log10(4), 2);
	});

	it('gates silence out of the integrated value', () => {
		const tone = sine(1000, 10 ** (-20 / 20), 5);
		const silence = new Float32Array(10 * SR);
		const mixed = new Float32Array(tone.length + silence.length);
		mixed.set(tone, 0);
		const result = measureLoudness([mixed], SR);
		expect(result.integratedLUFS).toBeCloseTo(-23.0, 0);
		expect(result.gatedBlockCount).toBeLessThan(result.totalBlockCount);
	});

	it('measures silence as -Infinity with no range', () => {
		const result = measureLoudness([new Float32Array(SR * 2)], SR);
		expect(result.integratedLUFS).toBe(-Infinity);
		expect(result.loudnessRangeLU).toBeNull();
		expect(result.truePeakDbTP).toBe(-Infinity);
		expect(result.samplePeakDbFS).toBe(-Infinity);
	});

	it('needs a full 400 ms block before it can say anything', () => {
		const result = measureLoudness([sine(1000, 0.5, 0.1)], SR);
		expect(result.integratedLUFS).toBe(-Infinity);
		expect(result.totalBlockCount).toBe(0);
	});

	it('reads true peak at least as hot as sample peak', () => {
		// A hot high-frequency sine hides its peaks between samples.
		// Raised-cosine edges keep the onset Gibbs out of the reading.
		const tone = faded(sine(20000, 10 ** (-3 / 20), 2), SR);
		const result = measureLoudness([tone], SR);
		expect(result.samplePeakDbFS).toBeLessThanOrEqual(-3.0 + 1e-9);
		expect(result.truePeakDbTP).toBeGreaterThanOrEqual(result.samplePeakDbFS - 0.05);
		expect(Math.abs(result.truePeakDbTP + 3.0)).toBeLessThan(0.1);
	});

	it('catches peaks hiding between samples', () => {
		// 12 kHz (fs/4) at 45°: every sample sits at ±0.707 of crest, so
		// the sample peak reads 3 dB cold while the true peak does not.
		const frames = 2 * SR;
		const tone = new Float32Array(frames);
		for (let i = 0; i < frames; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 12000 * i) / SR + Math.PI / 4);
		const result = measureLoudness([faded(tone, SR)], SR);
		expect(result.samplePeakDbFS).toBeCloseTo(20 * Math.log10(0.5 * Math.SQRT1_2), 1);
		expect(Math.abs(result.truePeakDbTP - 20 * Math.log10(0.5))).toBeLessThan(0.06);
		expect(result.truePeakDbTP - result.samplePeakDbFS).toBeGreaterThan(2.5);
	});

	it('catches onset overshoot instead of hiding it', () => {
		// An abruptly starting 20 kHz tone genuinely overshoots between
		// samples at its onset (Gibbs); the meter must report that, hot.
		const tone = sine(20000, 10 ** (-3 / 20), 2);
		const result = measureLoudness([tone], SR);
		expect(result.truePeakDbTP).toBeGreaterThan(result.samplePeakDbFS + 0.2);
	});

	it('agrees with itself across chunkings', () => {
		const tone = sine(880, 0.25, 4);
		const whole = measureLoudness([tone], SR);
		const meter = new LoudnessMeter(SR, 1);
		for (let at = 0; at < tone.length; at += 997) {
			meter.push([tone], at, Math.min(997, tone.length - at));
		}
		const chunked = meter.result();
		expect(chunked.integratedLUFS).toBe(whole.integratedLUFS);
		expect(chunked.truePeakDbTP).toBe(whole.truePeakDbTP);
		expect(chunked.loudnessRangeLU).toBe(whole.loudnessRangeLU);
	});

	it('spreads loudness range across two sustained levels', () => {
		const loud = sine(440, 0.5, 8);
		const quiet = sine(440, 0.05, 8);
		const mixed = new Float32Array(loud.length + quiet.length);
		mixed.set(loud, 0);
		mixed.set(quiet, loud.length);
		const result = measureLoudness([mixed], SR);
		// Two plateaus 20 dB apart; the relative gate (-20 LU) keeps both
		// only just — assert a wide range rather than the exact 20.
		expect(result.loudnessRangeLU).not.toBeNull();
		expect(result.loudnessRangeLU!).toBeGreaterThan(10);
	});

	it('rejects bad channel counts and mismatched pushes', () => {
		expect(() => new LoudnessMeter(SR, 0)).toThrow();
		expect(() => new LoudnessMeter(-1, 2)).toThrow();
		const meter = new LoudnessMeter(SR, 2);
		expect(() => meter.push([new Float32Array(8)], 0, 8)).toThrow();
	});
});
