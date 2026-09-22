/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { reframe } from './reframe';

import type { TrackFrame } from '@diffusionstudio/track';

const W = 160;
const H = 90;
const FPS = 30;

function frame(paint: (gray: Uint8Array) => void, time: number): TrackFrame {
	const gray = new Uint8Array(W * H).fill(32);
	paint(gray);
	return { gray, width: W, height: H, time };
}

function square(gray: Uint8Array, cx: number, cy: number, half: number, value = 255): void {
	for (let y = Math.floor(cy - half); y < Math.ceil(cy + half); y++) {
		for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
			if (x >= 0 && y >= 0 && x < W && y < H) gray[y * W + x] = value;
		}
	}
}

function centerX(crop: { x: number; width: number }): number {
	return crop.x + crop.width / 2;
}

describe('reframe', () => {
	it('follows a moving square to 9:16 with a full-height window', () => {
		const frames = Array.from({ length: 30 }, (_, n) =>
			frame((g) => square(g, 30 + (100 * n) / 29, H / 2, 10), n / FPS),
		);
		const found = reframe(frames, { aspect: '9:16', smoothing: 2 });
		expect(found.frames).toBe(30);
		for (const crop of found.crops) {
			expect(crop.width).toBe(51);
			expect(crop.height).toBe(90);
			expect(crop.y).toBe(0);
		}
		// Motion energy spans the old and new square, so the middle
		// trails truth by a constant ~1.5 px; the truncated kernel adds
		// a few px of lag at the ends. Tight inside, bounded overall,
		// and never jumping back: follow, but smoothly.
		found.crops.forEach((crop, n) => {
			expect(Math.abs(centerX(crop) - (30 + (100 * n) / 29))).toBeLessThanOrEqual(7);
		});
		found.crops.slice(8, 22).forEach((crop, k) => {
			expect(Math.abs(centerX(crop) - (30 + (100 * (k + 8)) / 29))).toBeLessThanOrEqual(2.5);
		});
		for (let n = 1; n < found.crops.length; n++) {
			expect(centerX(found.crops[n]!)).toBeGreaterThanOrEqual(centerX(found.crops[n - 1]!) - 1);
		}
	});

	it('holds still on a static textured frame', () => {
		const one = frame((g) => square(g, 110, 45, 12), 0);
		const frames = Array.from({ length: 12 }, (_, n) => ({ ...one, gray: one.gray.slice(), time: n / FPS }));
		const found = reframe(frames, { aspect: '9:16' });
		for (const crop of found.crops) {
			expect(crop.x).toBe(found.crops[0]!.x);
			expect(crop.y).toBe(found.crops[0]!.y);
		}
	});

	it('centers the crop on flat frames', () => {
		const frames = Array.from({ length: 5 }, (_, n) => frame(() => {}, n / FPS));
		const found = reframe(frames, { aspect: '9:16' });
		for (const crop of found.crops) {
			// Slack is 109 px, so exact center 54.5 rounds down by scan order.
			expect(crop.x).toBe(Math.floor((W - 51) / 2));
			expect(crop.y).toBe(0);
		}
		expect(found.meanCoverage).toBe(1);
	});

	it('resets smoothing at cuts instead of dragging across them', () => {
		const left = Array.from({ length: 10 }, (_, n) => frame((g) => square(g, 30, H / 2, 10), n / FPS));
		const right = Array.from({ length: 10 }, (_, n) => frame((g) => square(g, 130, H / 2, 10), (10 + n) / FPS));
		const frames = [...left, ...right];
		const withCut = reframe(frames, { aspect: '9:16', smoothing: 8, cuts: [10 / FPS] });
		expect(Math.abs(centerX(withCut.crops[9]!) - 30)).toBeLessThanOrEqual(6);
		expect(Math.abs(centerX(withCut.crops[10]!) - 130)).toBeLessThanOrEqual(6);
		const noCut = reframe(frames, { aspect: '9:16', smoothing: 8 });
		expect(Math.abs(centerX(noCut.crops[10]!) - 130)).toBeGreaterThan(6);
	});

	it('cuts a square window for 1:1', () => {
		const frames = Array.from({ length: 4 }, (_, n) => frame((g) => square(g, 80, 45, 10), n / FPS));
		const found = reframe(frames, { aspect: '1:1', smoothing: 0 });
		for (const crop of found.crops) {
			expect(crop.width).toBe(90);
			expect(crop.height).toBe(90);
			expect(crop.y).toBe(0);
		}
		expect(Math.abs(centerX(found.crops[0]!) - 80)).toBeLessThanOrEqual(4);
	});

	it('lets an explicit focus track override saliency', () => {
		const frames = Array.from({ length: 6 }, (_, n) =>
			frame((g) => {
				for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) g[y * W + x] = (x + y) % 2 ? 200 : 20;
			}, n / FPS),
		);
		const focus = frames.map((f) => ({ time: f.time, x: 0.85, y: 0.5 }));
		const found = reframe(frames, { aspect: '9:16', smoothing: 0, focus });
		for (const crop of found.crops) {
			expect(Math.abs(centerX(crop) - 0.85 * W)).toBeLessThanOrEqual(2);
		}
	});

	it('ignores a uniform noise floor instead of centering on it', () => {
		let seed = 7;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const frames = Array.from({ length: 10 }, (_, n) =>
			frame((g) => {
				for (let k = 0; k < g.length; k++) g[k] = 32 + Math.floor(rand() * 20);
				square(g, 120, H / 2, 10);
			}, n / FPS),
		);
		const found = reframe(frames, { aspect: '9:16', smoothing: 0 });
		for (const crop of found.crops) {
			expect(Math.abs(centerX(crop) - 120)).toBeLessThanOrEqual(3);
		}
	});

	it('reports coverage inside 0-1', () => {
		const frames = Array.from({ length: 8 }, (_, n) => frame((g) => square(g, 40 + n * 10, H / 2, 10), n / FPS));
		const found = reframe(frames, { aspect: '9:16', smoothing: 2 });
		expect(found.meanCoverage).toBeGreaterThan(0.5);
		expect(found.meanCoverage).toBeLessThanOrEqual(1);
	});

	it('rejects bad input honestly', () => {
		const frames = [frame((g) => square(g, 80, 45, 10), 0)];
		expect(() => reframe([], { aspect: '9:16' })).toThrow();
		expect(() => reframe(frames, { aspect: 'wide' })).toThrow();
		expect(() => reframe(frames, { aspect: '16:0' })).toThrow();
		expect(() => reframe(frames, { aspect: '9:16', smoothing: -1 })).toThrow();
		expect(() => reframe([...frames, { ...frames[0]!, width: 80 }], { aspect: '9:16' })).toThrow();
		expect(() => reframe(frames, { aspect: '9:16', focus: [] })).toThrow();
	});
});
