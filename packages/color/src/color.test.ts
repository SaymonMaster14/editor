/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { applyGrade, scopeClip } from './color';

import type { SceneFrame } from '@diffusionstudio/scene';

const W = 160;
const H = 80;

function frame(paint: (data: Uint8Array) => void, time = 0): SceneFrame {
	const data = new Uint8Array(W * H * 3);
	paint(data);
	return { data, width: W, height: H, time };
}

function fill(data: Uint8Array, r: number, g: number, b: number): void {
	for (let i = 0; i < data.length; i += 3) {
		data[i] = r;
		data[i + 1] = g;
		data[i + 2] = b;
	}
}

describe('scopes', () => {
	it('reads flat mid-gray as flat, unclipped, cast-free', () => {
		const found = scopeClip([frame((d) => fill(d, 128, 128, 128))]);
		const s = found.samples[0]!;
		expect(s.meanLuma).toBeCloseTo(128, 6);
		expect(s.lumaStd).toBe(0);
		expect(s.clippedBlack).toBe(0);
		expect(s.clippedWhite).toBe(0);
		expect(s.castToward).toBe('none');
		expect(found.verdict).toBe('flat');
	});

	it('names heavy clipping, white over black', () => {
		const half = frame((d) => {
			fill(d, 0, 0, 0);
			for (let y = 0; y < H / 2; y++) for (let x = 0; x < W; x++) {
				const at = (y * W + x) * 3;
				d[at] = d[at + 1] = d[at + 2] = 255;
			}
		});
		const found = scopeClip([half]);
		expect(found.samples[0]!.clippedBlack).toBeCloseTo(0.5, 6);
		expect(found.samples[0]!.clippedWhite).toBeCloseTo(0.5, 6);
		expect(found.verdict).toBe('clipped-white');
	});

	it('detects a red cast', () => {
		const found = scopeClip([frame((d) => fill(d, 200, 100, 100))]);
		expect(found.samples[0]!.castToward).toBe('red');
		expect(found.samples[0]!.castStrength).toBeCloseTo(100 / ((200 + 100 + 100) / 3), 6);
		expect(found.verdict).toBe('cast');
	});

	it('fills histograms that sum to the pixel count', () => {
		const grad = frame((d) => {
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
				const v = Math.floor((x * 256) / W);
				const at = (y * W + x) * 3;
				d[at] = d[at + 1] = d[at + 2] = v;
			}
		});
		const s = scopeClip([grad]).samples[0]!;
		expect(s.lumaHist.reduce((a, b) => a + b, 0)).toBe(W * H);
		expect(s.rgbHist[0]!.reduce((a, b) => a + b, 0)).toBe(W * H);
		// Gradient spreads luma across every bin.
		expect(s.lumaHist.every((c) => c > 0)).toBe(true);
	});

	it('maps waveform bands top to bottom', () => {
		const half = frame((d) => {
			fill(d, 0, 0, 0);
			for (let y = 0; y < H / 2; y++) for (let x = 0; x < W; x++) {
				const at = (y * W + x) * 3;
				d[at] = d[at + 1] = d[at + 2] = 255;
			}
		});
		const wave = scopeClip([half]).samples[0]!.waveform;
		expect(wave.length).toBe(8);
		for (const [mn, mx] of wave.slice(0, 4)) {
			expect([mn, mx]).toEqual([255, 255]);
		}
		for (const [mn, mx] of wave.slice(4)) {
			expect([mn, mx]).toEqual([0, 0]);
		}
	});
});

describe('grade', () => {
	it('grades identity to identical bytes', () => {
		const f = frame((d) => fill(d, 40, 120, 200));
		const out = applyGrade(f, {});
		expect([...out.data]).toEqual([...f.data]);
	});

	it('applies exposure stops exactly', () => {
		const f = frame((d) => fill(d, 100, 100, 100));
		const out = applyGrade(f, { exposure: 1 });
		expect([...new Set(out.data)]).toEqual([200]);
	});

	it('applies contrast around mid-gray exactly', () => {
		const f = frame((d) => fill(d, 100, 100, 100));
		const out = applyGrade(f, { contrast: 2 });
		expect([...new Set(out.data)]).toEqual([72]);
	});

	it('desaturates to luma exactly', () => {
		const f = frame((d) => fill(d, 200, 100, 50));
		const out = applyGrade(f, { saturation: 0 });
		const luma = Math.round(0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50);
		expect(out.data[0]).toBe(luma);
		expect(out.data[1]).toBe(luma);
		expect(out.data[2]).toBe(luma);
	});

	it('warms with the red/blue seesaw exactly', () => {
		const f = frame((d) => fill(d, 100, 100, 100));
		const out = applyGrade(f, { temperature: 1 });
		expect([out.data[0], out.data[1], out.data[2]]).toEqual([125, 100, 75]);
	});

	it('applies lift, gain, and gamma per channel', () => {
		const f = frame((d) => fill(d, 100, 100, 100));
		const lifted = applyGrade(f, { lift: [0.1, 0, -0.1] });
		expect([lifted.data[0], lifted.data[1], lifted.data[2]]).toEqual([126, 100, 75]);
		const gained = applyGrade(f, { gain: [2, 1, 0.5] });
		expect([gained.data[0], gained.data[1], gained.data[2]]).toEqual([200, 100, 50]);
		const gammed = applyGrade(f, { gamma: [2, 1, 1] });
		expect(gammed.data[0]).toBe(Math.round(255 * (100 / 255) ** 2));
		expect(gammed.data[1]).toBe(100);
	});

	it('rejects bad input honestly', () => {
		const f = frame((d) => fill(d, 100, 100, 100));
		expect(() => scopeClip([])).toThrow();
		expect(() => scopeClip([f, { ...f, width: 8 }])).toThrow();
		expect(() => applyGrade(f, { exposure: 9 })).toThrow();
		expect(() => applyGrade(f, { contrast: -1 })).toThrow();
		expect(() => applyGrade(f, { temperature: 2 })).toThrow();
		expect(() => applyGrade(f, { gamma: [1, 1, 0] })).toThrow();
	});
});
