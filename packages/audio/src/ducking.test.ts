/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { duckingCurve } from './ducking';

import type { EnvelopePoint } from './ducking';

const SETTINGS = { thresholdDb: -30, depthDb: -8, attackMs: 10, releaseMs: 100 };

function envelope(levels: Array<[number, number]>): EnvelopePoint[] {
	return levels.map(([time, levelDb]) => ({ time, levelDb }));
}

function gainAt(curve: Array<{ time: number; gainDb: number }>, time: number): number {
	let gain = 0;
	for (const point of curve) {
		if (point.time > time) break;
		gain = point.gainDb;
	}
	return gain;
}

describe('duckingCurve', () => {
	it('ducks nothing on an empty or sub-threshold envelope', () => {
		expect(duckingCurve([], SETTINGS)).toEqual([{ time: 0, gainDb: 0 }]);
		const curve = duckingCurve(envelope([[0, -60], [1, -50], [2, -40]]), SETTINGS);
		expect(curve.every((point) => point.gainDb === 0)).toBe(true);
	});

	it('reaches full depth on sustained loud key and recovers after', () => {
		const points: Array<[number, number]> = [];
		for (let t = 0; t <= 2; t += 0.05) points.push([t, t >= 0.5 && t < 1.5 ? -10 : -60]);
		const curve = duckingCurve(envelope(points), SETTINGS);
		// Fast attack: fully ducked shortly after the key trips.
		expect(gainAt(curve, 0.4)).toBe(0);
		expect(gainAt(curve, 0.7)).toBeLessThan(-7.9);
		expect(gainAt(curve, 1.4)).toBeLessThan(-7.9);
		// Release: recovering but not yet home 50 ms after the key drops…
		const dropping = gainAt(curve, 1.55);
		expect(dropping).toBeGreaterThan(-8);
		expect(dropping).toBeLessThan(-1);
		// …and fully recovered well after.
		expect(gainAt(curve, 2.0)).toBeGreaterThan(-0.1);
	});

	it('holds depth through the hold window', () => {
		const points: Array<[number, number]> = [];
		for (let t = 0; t <= 1; t += 0.02) points.push([t, t < 0.5 ? -10 : -60]);
		const curve = duckingCurve(envelope(points), { ...SETTINGS, holdMs: 200 });
		expect(gainAt(curve, 0.6)).toBeLessThan(-7.9);
		expect(gainAt(curve, 0.9)).toBeGreaterThan(-7.9);
	});

	it('never boosts and never exceeds depth', () => {
		const points: Array<[number, number]> = [];
		for (let t = 0; t <= 1; t += 0.01) points.push([t, -20 + 10 * Math.sin(t * 40)]);
		const curve = duckingCurve(envelope(points), SETTINGS);
		for (const point of curve) {
			expect(point.gainDb).toBeLessThanOrEqual(0);
			expect(point.gainDb).toBeGreaterThanOrEqual(-8 - 1e-9);
		}
	});

	it('clamps a positive depth to unity', () => {
		const curve = duckingCurve(envelope([[0, -10], [1, -10]]), { ...SETTINGS, depthDb: 6 });
		expect(curve.every((point) => point.gainDb === 0)).toBe(true);
	});
});
