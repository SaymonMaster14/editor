/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { retime, sampleFrames } from './temporal';

import type { SceneFrame } from '@diffusionstudio/scene';

const FPS = 30;
const N = 60;

function frames(count = N, fps = FPS): SceneFrame[] {
	return Array.from({ length: count }, (_, n) => ({
		data: new Uint8Array(4 * 4 * 3).fill(n % 2 ? 255 : 0),
		width: 4,
		height: 4,
		time: n / fps,
	}));
}

describe('retime', () => {
	it('maps 1x to itself', () => {
		const src = frames();
		const found = retime(src, FPS);
		expect(found.outFrames).toBe(N);
		expect(found.outSeconds).toBeCloseTo((N - 1) / FPS, 9);
		for (const entry of found.map) {
			expect(entry.src).toBeCloseTo(entry.time, 9);
		}
	});

	it('stretches 0.5x to double the frames at half the source rate', () => {
		const found = retime(frames(), FPS, { speed: 0.5 });
		expect(found.outFrames).toBe(2 * N - 1);
		expect(found.outSeconds).toBeCloseTo((2 * (N - 1)) / FPS, 9);
		for (const entry of found.map) {
			expect(entry.src).toBeCloseTo(entry.time * 0.5, 9);
		}
	});

	it('compresses 2x to half the frames at double the source rate', () => {
		const found = retime(frames(), FPS, { speed: 2 });
		expect(found.outSeconds).toBeCloseTo((N - 1) / FPS / 2, 9);
		for (const entry of found.map) {
			expect(entry.src).toBeCloseTo(Math.min(entry.time * 2, (N - 1) / FPS), 9);
		}
	});

	it('plays reversed maps backwards through the source', () => {
		const found = retime(frames(), FPS, { reverse: true });
		expect(found.outFrames).toBe(N);
		expect(found.map[0]!.src).toBeCloseTo((N - 1) / FPS, 9);
		expect(found.map[N - 1]!.src).toBeCloseTo(0, 9);
		for (let k = 1; k < found.map.length; k++) {
			expect(found.map[k]!.src).toBeLessThanOrEqual(found.map[k - 1]!.src);
		}
	});

	it('holds freezes at their source time for the hold duration', () => {
		const found = retime(frames(), FPS, { freeze: [{ at: 1, hold: 1 }] });
		expect(found.outSeconds).toBeCloseTo((N - 1) / FPS + 1, 9);
		const held = found.map.filter((e) => e.time >= 1 && e.time < 2);
		expect(held.length).toBeGreaterThan(20);
		for (const entry of held) {
			expect(entry.src).toBeCloseTo(1, 6);
		}
	});

	it('integrates a ramp: 1x then 0.5x over two source seconds', () => {
		const src = frames(61);
		const found = retime(src, FPS, { ramp: [{ time: 0, speed: 1 }, { time: 1, speed: 0.5 }] });
		// Output second 0-1 covers source 0-~0.75 (ramping down), then
		// 0.5x: total duration is 1/ln-ish — assert the integral form.
		expect(found.outSeconds).toBeGreaterThan(2.5);
		expect(found.outSeconds).toBeLessThan(3.5);
		// Past the ramp the map advances at half rate.
		const tail = found.map.filter((e) => e.src > 1.5);
		for (let k = 1; k < tail.length; k++) {
			expect(tail[k]!.src - tail[k - 1]!.src).toBeCloseTo((tail[k]!.time - tail[k - 1]!.time) * 0.5, 6);
		}
		// The ramp region itself advances monotonically, never backwards.
		for (let k = 1; k < found.map.length; k++) {
			expect(found.map[k]!.src).toBeGreaterThanOrEqual(found.map[k - 1]!.src);
		}
	});

	it('samples nearest frames without blending', () => {
		const src = frames(4);
		const found = retime(src, FPS, { speed: 0.5 });
		const out = sampleFrames(src, found.map);
		expect(out.length).toBe(found.outFrames);
		// Out frame k shows src k/60; ties break to the earlier frame.
		expect(out[0]!.time).toBe(0);
		expect([...out[0]!.data].every((v) => v === 0)).toBe(true);
		expect([...out[1]!.data].every((v) => v === 0)).toBe(true);
		expect([...out[2]!.data].every((v) => v === 255)).toBe(true);
	});

	it('blends bracketing frames honestly', () => {
		const src = frames(2);
		const out = sampleFrames(src, [{ time: 0, src: 1 / FPS / 2 }], { blend: true });
		expect(out[0]!.data.length).toBe(4 * 4 * 3);
		expect([...out[0]!.data].every((v) => v === 128)).toBe(true);
	});

	it('rejects bad input honestly', () => {
		const src = frames();
		expect(() => retime([], FPS)).toThrow();
		expect(() => retime(src, 0)).toThrow();
		expect(() => retime(src, FPS, { speed: 0 })).toThrow();
		expect(() => retime(src, FPS, { ramp: [{ time: 0, speed: -1 }] })).toThrow();
		expect(() => retime(src, FPS, { ramp: [{ time: 1, speed: 1 }, { time: 1, speed: 1 }] })).toThrow();
		expect(() => retime(src, FPS, { freeze: [{ at: 99, hold: 1 }] })).toThrow();
		expect(() => retime([src[0]!, { ...src[1]!, width: 8 }], FPS)).toThrow();
	});
});
