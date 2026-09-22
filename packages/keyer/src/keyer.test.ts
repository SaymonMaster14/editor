/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { keyClip, keyFrame } from './keyer';

import type { SceneFrame } from '@diffusionstudio/scene';
import type { Rgb } from './keyer';

const W = 160;
const H = 90;
const GREEN: Rgb = [0, 200, 0];

function frame(paint: (data: Uint8Array) => void, time = 0): SceneFrame {
	const data = new Uint8Array(W * H * 3);
	paint(data);
	return { data, width: W, height: H, time };
}

function fill(data: Uint8Array, [r, g, b]: Rgb): void {
	for (let i = 0; i < data.length; i += 3) {
		data[i] = r;
		data[i + 1] = g;
		data[i + 2] = b;
	}
}

function square(data: Uint8Array, cx: number, cy: number, half: number, [r, g, b]: Rgb): void {
	for (let y = Math.floor(cy - half); y < Math.ceil(cy + half); y++) {
		for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const at = (y * W + x) * 3;
			data[at] = r;
			data[at + 1] = g;
			data[at + 2] = b;
		}
	}
}

describe('keyer', () => {
	it('estimates a green screen and keys a white square clean', () => {
		const frames = [0, 1].map((n) =>
			frame((d) => {
				fill(d, GREEN);
				square(d, W / 2, H / 2, 20, [255, 255, 255]);
			}, n / 30),
		);
		const found = keyClip(frames);
		expect(found.screen).toEqual([0, 200, 0]);
		expect(found.verdict).toBe('clean');
		expect(found.meanFg).toBeCloseTo((40 * 40) / (W * H), 2);
		expect(found.meanEdge).toBeLessThan(0.05);
	});

	it('feathers the tolerance/softness band honestly', () => {
		const f = frame((d) => {
			fill(d, GREEN);
			const set = (x: number, c: Rgb) => {
				const at = (45 * W + x) * 3;
				d[at] = c[0];
				d[at + 1] = c[1];
				d[at + 2] = c[2];
			};
			set(10, [0, 140, 0]); // dist 60: fully keyed
			set(11, [0, 120, 0]); // dist 80: half feather
			set(12, [0, 100, 0]); // dist 100: fully foreground
		});
		const { matte } = keyFrame(f, GREEN, { tolerance: 60, softness: 40, soften: 0, despill: false });
		expect(matte.alpha[45 * W + 10]).toBe(0);
		expect(matte.alpha[45 * W + 11]).toBe(128);
		expect(matte.alpha[45 * W + 12]).toBe(255);
	});

	it('despills green fringe on foreground pixels', () => {
		const f = frame((d) => {
			fill(d, GREEN);
			square(d, W / 2, H / 2, 20, [200, 255, 200]);
		});
		const fixed = keyFrame(f, GREEN, { soften: 0 });
		const at = (45 * W + 80) * 3;
		expect(fixed.matte.rgb[at + 1]).toBe(215);
		expect(fixed.sample.spillFraction).toBeGreaterThan(0);
		const raw = keyFrame(f, GREEN, { soften: 0, despill: false });
		expect(raw.matte.rgb[at + 1]).toBe(255);
		expect(raw.sample.spillFraction).toBe(0);
	});

	it('cuts garbage boxes to background', () => {
		const f = frame((d) => {
			fill(d, GREEN);
			square(d, W / 2, H / 2, 20, [255, 255, 255]);
		});
		const kept = keyClip([f]);
		expect(kept.meanFg).toBeGreaterThan(0.1);
		const cut = keyClip([f], { garbage: [{ x: 40, y: 5, width: 80, height: 80 }] });
		expect(cut.meanFg).toBe(0);
	});

	it('reads a gray frame as a weak screen, not a key', () => {
		const found = keyClip([frame((d) => fill(d, [128, 128, 128]))]);
		expect(found.screen).toEqual([128, 128, 128]);
		expect(found.screenSaturation).toBe(0);
		expect(found.verdict).toBe('weak-screen');
	});

	it('reads an all-feather frame as noisy', () => {
		const found = keyClip([frame((d) => fill(d, [0, 120, 0]))], { screen: GREEN, soften: 0 });
		expect(found.meanFg).toBe(0);
		expect(found.samples[0]!.edgeFraction).toBe(1);
		expect(found.verdict).toBe('noisy');
	});

	it('softening turns hard steps into feathered edges', () => {
		const f = frame((d) => {
			fill(d, GREEN);
			square(d, W / 2, H / 2, 20, [255, 255, 255]);
		});
		const hard = keyFrame(f, GREEN, { soften: 0, despill: false });
		expect([...hard.matte.alpha].every((a) => a === 0 || a === 255)).toBe(true);
		const soft = keyFrame(f, GREEN, { soften: 1, despill: false });
		expect([...soft.matte.alpha].some((a) => a > 0 && a < 255)).toBe(true);
	});

	it('rejects bad input honestly', () => {
		const f = frame((d) => fill(d, GREEN));
		expect(() => keyClip([])).toThrow();
		expect(() => keyClip([f, { ...f, width: 80 }])).toThrow();
		expect(() => keyClip([f], { screen: [0, 300, 0] })).toThrow();
		expect(() => keyClip([f], { tolerance: -1 })).toThrow();
		expect(() => keyClip([f], { softness: 0 })).toThrow();
		expect(() => keyClip([f], { soften: 3 })).toThrow();
	});
});
