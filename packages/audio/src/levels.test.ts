/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { amplitudeToDb, clampDb, dbToAmplitude, powerToDb } from './db';
import { fadeGainDbAt } from './fades';
import { stereoGains } from './pan';

describe('db', () => {
	it('converts amplitudes both ways', () => {
		expect(amplitudeToDb(1)).toBe(0);
		expect(amplitudeToDb(0.5)).toBeCloseTo(-6.0206, 4);
		expect(amplitudeToDb(0)).toBe(-Infinity);
		expect(amplitudeToDb(-3)).toBe(-Infinity);
		expect(dbToAmplitude(0)).toBe(1);
		expect(dbToAmplitude(-Infinity)).toBe(0);
		expect(dbToAmplitude(-6.0206)).toBeCloseTo(0.5, 4);
	});

	it('compares powers with 10·log10', () => {
		expect(powerToDb(1)).toBe(0);
		expect(powerToDb(0.25)).toBeCloseTo(-6.0206, 4);
		expect(powerToDb(0)).toBe(-Infinity);
	});

	it('clamps, preserving silence', () => {
		expect(clampDb(-200)).toBe(-96);
		expect(clampDb(100)).toBe(24);
		expect(clampDb(-Infinity)).toBe(-Infinity);
		expect(clampDb(0, -12, 12)).toBe(0);
	});
});

describe('fades', () => {
	it('is unity through the body and silent at the edges', () => {
		const shape = { in: 1, out: 2, duration: 10 };
		expect(fadeGainDbAt(0, shape)).toBe(-Infinity);
		expect(fadeGainDbAt(5, shape)).toBe(0);
		expect(fadeGainDbAt(10, shape)).toBe(-Infinity);
	});

	it('ramps linearly by default (-6 dB at the midpoint)', () => {
		const shape = { in: 2, out: 0, duration: 10 };
		expect(fadeGainDbAt(1, shape)).toBeCloseTo(-6.0206, 4);
		expect(fadeGainDbAt(2, shape)).toBe(0);
	});

	it('ramps equal-power at -3 dB at the midpoint', () => {
		const shape = { in: 2, out: 0, duration: 10, curve: 'equalPower' as const };
		expect(fadeGainDbAt(1, shape)).toBeCloseTo(-3.0103, 4);
	});

	it('meets in the middle when fades overlap, and clamps outside', () => {
		const shape = { in: 8, out: 8, duration: 10 };
		expect(fadeGainDbAt(5, shape)).toBeCloseTo(20 * Math.log10(0.625 * 0.625), 4);
		expect(fadeGainDbAt(-1, shape)).toBe(-Infinity);
		expect(fadeGainDbAt(11, shape)).toBe(-Infinity);
	});

	it('is unity without fades', () => {
		expect(fadeGainDbAt(3, { in: 0, out: 0, duration: 10 })).toBe(0);
	});
});

describe('pan', () => {
	it('parks hard left/center/right under equal power', () => {
		const left = stereoGains(-1);
		expect(left.left).toBeCloseTo(1, 6);
		expect(left.right).toBeCloseTo(0, 6);
		const right = stereoGains(1);
		expect(right.left).toBeCloseTo(0, 6);
		expect(right.right).toBeCloseTo(1, 6);
		const center = stereoGains(0);
		expect(center.left).toBeCloseTo(Math.SQRT1_2, 6);
		expect(center.right).toBeCloseTo(Math.SQRT1_2, 6);
		// Equal power: energy constant across the field.
		for (const pan of [-0.7, -0.2, 0.33, 0.9]) {
			const { left, right } = stereoGains(pan);
			expect(left * left + right * right).toBeCloseTo(1, 6);
		}
	});

	it('crossfades linearly', () => {
		expect(stereoGains(0, 'linear')).toEqual({ left: 0.5, right: 0.5 });
		expect(stereoGains(-1, 'linear')).toEqual({ left: 1, right: 0 });
	});

	it('clamps out-of-range pans', () => {
		expect(stereoGains(-5)).toEqual(stereoGains(-1));
		const hot = stereoGains(5);
		expect(hot.left).toBeCloseTo(0, 6);
		expect(hot.right).toBeCloseTo(1, 6);
		expect(stereoGains(Number.NaN)).toEqual(stereoGains(0));
	});
});
