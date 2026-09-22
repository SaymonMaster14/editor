/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { CutScanner, detectCuts, histogramDistance, nearestCut, shotAt } from './cuts';

import type { SceneFrame } from './cuts';

const W = 16;
const H = 12;

function solid(r: number, g: number, b: number, time: number): SceneFrame {
	const data = new Uint8Array(W * H * 3);
	for (let i = 0; i < data.length; i += 3) {
		data[i] = r;
		data[i + 1] = g;
		data[i + 2] = b;
	}
	return { data, width: W, height: H, time };
}

/** `runs` of [frames, r, g, b] at `fps`, concatenated in order. */
function sequence(runs: Array<[number, number, number, number]>, fps = 30): SceneFrame[] {
	const frames: SceneFrame[] = [];
	let n = 0;
	for (const [count, r, g, b] of runs) {
		for (let i = 0; i < count; i++) frames.push(solid(r, g, b, n++ / fps));
	}
	return frames;
}

describe('detectCuts', () => {
	it('returns empty without frames', () => {
		expect(detectCuts([])).toEqual({ cuts: [], shots: [], frames: 0, seconds: 0 });
	});

	it('returns one shot for a single frame', () => {
		const found = detectCuts([solid(10, 20, 30, 0)]);
		expect(found.cuts).toEqual([]);
		expect(found.shots).toEqual([{ index: 0, start: 0, end: 0 }]);
	});

	it('finds no cuts in static footage', () => {
		const found = detectCuts(sequence([[90, 200, 100, 50]]));
		expect(found.cuts).toEqual([]);
		expect(found.shots).toEqual([{ index: 0, start: 0, end: 89 / 30 }]);
	});

	it('finds a hard cut at the first frame of the new shot', () => {
		const found = detectCuts(sequence([[30, 255, 0, 0], [30, 0, 255, 0]]));
		expect(found.cuts).toEqual([1]);
		expect(found.shots).toEqual([
			{ index: 0, start: 0, end: 1 },
			{ index: 1, start: 1, end: 59 / 30 },
		]);
	});

	it('keeps well-separated cuts', () => {
		const found = detectCuts(sequence([[30, 255, 0, 0], [30, 0, 255, 0], [30, 0, 0, 255]]));
		expect(found.cuts).toEqual([1, 2]);
		expect(found.shots.map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 2], [2, 89 / 30]]);
	});

	it('rejects a single-frame flash', () => {
		const found = detectCuts(sequence([[10, 255, 0, 0], [1, 255, 255, 255], [10, 255, 0, 0]]));
		expect(found.cuts).toEqual([]);
		expect(found.shots).toHaveLength(1);
	});

	it('ignores a gradual ramp that never jumps', () => {
		// Textured ramp: pure-solid ramps cross histogram bin edges as a
		// staircase (every pixel jumps bins on the same frame), so each
		// frame carries fixed per-pixel noise that spreads bin crossings
		// over time the way real footage does.
		let seed = 0x12345678;
		const rand = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0xffffffff - 0.5;
		};
		const frames: SceneFrame[] = [];
		for (let i = 0; i < 40; i++) {
			const t = i / 39;
			const data = new Uint8Array(W * H * 3);
			for (let p = 0; p < data.length; p += 3) {
				data[p] = Math.max(0, Math.min(255, Math.round(255 * (1 - t) + rand() * 96)));
				data[p + 1] = Math.max(0, Math.min(255, Math.round(255 * t + rand() * 96)));
				data[p + 2] = Math.max(0, Math.min(255, Math.round(rand() * 96)));
			}
			frames.push({ data, width: W, height: H, time: i / 30 });
		}
		expect(detectCuts(frames).cuts).toEqual([]);
	});

	it('collapses cuts closer than a minimum shot, keeping the earliest tie', () => {
		const found = detectCuts(sequence([[30, 255, 0, 0], [5, 0, 255, 0], [30, 0, 0, 255]]));
		expect(found.cuts).toEqual([1]);
	});

	it('respects an explicit minimum shot length', () => {
		const frames = sequence([[30, 255, 0, 0], [30, 0, 255, 0], [30, 0, 0, 255]]);
		expect(detectCuts(frames, { minShotSeconds: 2 }).cuts).toEqual([1]);
		expect(detectCuts(frames, { minShotSeconds: 0 }).cuts).toEqual([1, 2]);
	});

	it('respects an explicit threshold', () => {
		const frames = sequence([[30, 255, 0, 0], [30, 0, 255, 0]]);
		expect(detectCuts(frames, { threshold: 3 }).cuts).toEqual([]);
	});

	it('rejects malformed input', () => {
		const bad = { data: new Uint8Array(10), width: W, height: H, time: 0 };
		expect(() => detectCuts([bad])).toThrow(/width\*height\*3/);
		expect(() => detectCuts([{ ...solid(0, 0, 0, 0), width: 0 }])).toThrow(/dimensions/);
		expect(() => detectCuts([solid(0, 0, 0, 0)], { bins: 1 })).toThrow(/bins/);
		expect(() => detectCuts([solid(0, 0, 0, 0)], { threshold: 0 })).toThrow(/threshold/);
	});
});

describe('CutScanner', () => {
	it('matches detectCuts when frames arrive one by one', () => {
		const frames = sequence([[30, 255, 0, 0], [30, 0, 255, 0], [30, 0, 0, 255]]);
		const scanner = new CutScanner();
		for (const frame of frames) scanner.push(frame);
		expect(scanner.frames).toBe(90);
		expect(scanner.result()).toEqual(detectCuts(frames));
	});

	it('reports an empty scan without frames', () => {
		expect(new CutScanner().result()).toEqual({ cuts: [], shots: [], frames: 0, seconds: 0 });
	});
});

describe('histogramDistance', () => {
	it('is 0 for identical histograms and 2 for disjoint ones', () => {
		const a = new Float64Array([0.5, 0.5, 0, 0]);
		expect(histogramDistance(a, a)).toBe(0);
		expect(histogramDistance(a, new Float64Array([0, 0, 0.5, 0.5]))).toBe(2);
	});
});

describe('shot helpers', () => {
	const shots = [
		{ index: 0, start: 0, end: 1 },
		{ index: 1, start: 1, end: 2 },
	];

	it('shotAt clamps outside footage and returns null without shots', () => {
		expect(shotAt(shots, 0.5)).toEqual(shots[0]);
		expect(shotAt(shots, 1.5)).toEqual(shots[1]);
		expect(shotAt(shots, -5)).toEqual(shots[0]);
		expect(shotAt(shots, 99)).toEqual(shots[1]);
		expect(shotAt([], 1)).toBeNull();
	});

	it('nearestCut finds the closest cut and returns null without cuts', () => {
		expect(nearestCut([1, 2], 1.7)).toBe(2);
		expect(nearestCut([1, 2], 1.2)).toBe(1);
		expect(nearestCut([], 1)).toBeNull();
	});
});
