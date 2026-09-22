/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { sampleAt, trackPoint } from './track';

import type { PixelBox, TrackFrame } from './track';

const W = 64;
const H = 48;
const S = 12;

function square(x: number, y: number, time: number): TrackFrame {
	const gray = new Uint8Array(W * H);
	for (let dy = 0; dy < S; dy++) {
		for (let dx = 0; dx < S; dx++) {
			const px = x + dx;
			const py = y + dy;
			if (px >= 0 && px < W && py >= 0 && py < H) gray[py * W + px] = 255;
		}
	}
	return { gray, width: W, height: H, time };
}

function black(time: number): TrackFrame {
	return { gray: new Uint8Array(W * H), width: W, height: H, time };
}

/** White square gliding right `step` px per frame from (8, 10). */
function glide(frames: number, step: number, fps = 30): TrackFrame[] {
	const out: TrackFrame[] = [];
	for (let i = 0; i < frames; i++) out.push(square(8 + i * step, 10, i / fps));
	return out;
}

const KEY: PixelBox = { x: 8, y: 10, width: S, height: S };

describe('trackPoint', () => {
	it('holds still on a static box with full confidence', () => {
		const track = trackPoint(glide(10, 0), KEY, 0);
		expect(track.keyframe).toBe(0);
		expect(track.samples).toHaveLength(10);
		for (const s of track.samples) {
			expect(s.x).toBeCloseTo((8 + S / 2) / W, 10);
			expect(s.y).toBeCloseTo((10 + S / 2) / H, 10);
			expect(s.confidence).toBeGreaterThan(0.999);
			expect(s.lost).toBe(false);
		}
	});

	it('follows a moving box within half a pixel', () => {
		const track = trackPoint(glide(10, 3), KEY, 0);
		for (let i = 0; i < 10; i++) {
			const s = track.samples[i]!;
			expect(s.x * W).toBeCloseTo(8 + i * 3 + S / 2, 0);
			expect(s.confidence).toBeGreaterThan(0.95);
			expect(s.lost).toBe(false);
		}
	});

	it('tracks backward from a late keyframe to match a forward run', () => {
		const frames = glide(10, 3);
		const forward = trackPoint(frames, KEY, 0);
		const last = frames[frames.length - 1]!;
		const late: PixelBox = { x: 8 + 9 * 3, y: 10, width: S, height: S };
		const backward = trackPoint(frames, late, last.time);
		expect(backward.keyframe).toBe(9);
		for (let i = 0; i < 10; i++) {
			expect(backward.samples[i]!.x).toBeCloseTo(forward.samples[i]!.x, 2);
		}
	});

	it('marks occluded frames lost, holds position, and recovers', () => {
		const frames = glide(10, 2);
		frames[4] = black(4 / 30);
		frames[5] = black(5 / 30);
		frames[6] = black(6 / 30);
		const track = trackPoint(frames, KEY, 0);
		// Occluded: lost, near-zero confidence, holding frame 3's spot.
		for (const i of [4, 5, 6]) {
			const s = track.samples[i]!;
			expect(s.lost).toBe(true);
			expect(s.confidence).toBeLessThan(0.1);
			expect(s.x * W).toBeCloseTo(8 + 3 * 2 + S / 2, 0);
		}
		// Recovered: found again once the square returns.
		for (const i of [7, 8, 9]) {
			const s = track.samples[i]!;
			expect(s.lost).toBe(false);
			expect(s.x * W).toBeCloseTo(8 + i * 2 + S / 2, 0);
		}
	});

	it('loses motion that outruns the search radius instead of guessing', () => {
		const track = trackPoint(glide(4, 30), KEY, 0, { searchRadius: 24 });
		expect(track.samples[0]!.lost).toBe(false);
		for (const i of [1, 2, 3]) expect(track.samples[i]!.lost).toBe(true);
	});

	it('reads a flat template as lost with zero confidence', () => {
		const frames = [black(0), black(1 / 30), black(2 / 30)];
		const track = trackPoint(frames, KEY, 0);
		for (const s of track.samples) {
			expect(s.confidence).toBe(0);
			expect(s.lost).toBe(true);
		}
	});

	it('rejects malformed input', () => {
		expect(() => trackPoint([], KEY, 0)).toThrow(/at least one frame/);
		const frames = glide(3, 0);
		expect(() => trackPoint(frames, { x: -1, y: 0, width: S, height: S }, 0)).toThrow(/outside/);
		expect(() => trackPoint(frames, { x: 60, y: 0, width: S, height: S }, 0)).toThrow(/outside/);
		expect(() => trackPoint(frames, { x: 8, y: 10, width: 2, height: 2 }, 0)).toThrow(/at least 4x4/);
		expect(() => trackPoint(frames, KEY, 0, { searchRadius: -1 })).toThrow(/searchRadius/);
		expect(() => trackPoint(frames, KEY, NaN)).toThrow(/finite keyframe/);
		const mixed = [...frames, { ...square(8, 10, 3 / 30), width: 32 }];
		expect(() => trackPoint(mixed, KEY, 0)).toThrow(/width\*height/);
	});
});

describe('sampleAt', () => {
	it('finds the nearest sample and returns null without samples', () => {
		const track = trackPoint(glide(10, 3), KEY, 0);
		expect(sampleAt(track.samples, 0.16)!.time).toBeCloseTo(5 / 30, 10);
		expect(sampleAt([], 1)).toBeNull();
	});
});
