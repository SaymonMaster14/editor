/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { motionAt, stabilize } from './stabilize';

import type { TrackFrame } from '@diffusionstudio/track';

const W = 64;
const H = 48;
const FPS = 30;

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

/** Static noise world; frames are windows sliding over it like a camera. */
function world(w: number, h: number, seed = 7): Uint8Array {
	const rand = rng(seed);
	const gray = new Uint8Array(w * h);
	for (let i = 0; i < gray.length; i++) gray[i] = Math.floor(rand() * 256);
	return gray;
}

function windowAt(canvas: Uint8Array, cw: number, ox: number, oy: number, time: number): TrackFrame {
	const gray = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) gray[y * W + x] = canvas[(oy + y) * cw + ox + x]!;
	}
	return { gray, width: W, height: H, time };
}

function rms(values: number[]): number {
	return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

describe('stabilize', () => {
	it('reports zero motion on a static camera', () => {
		const canvas = world(128, 96);
		const frames: TrackFrame[] = [];
		for (let i = 0; i < 10; i++) frames.push(windowAt(canvas, 128, 20, 16, i / FPS));
		const found = stabilize(frames, { patches: 3 });
		expect(found.patches.length).toBeGreaterThan(0);
		expect(found.validFrames).toBe(10);
		for (const m of found.motion) {
			expect(m.valid).toBe(true);
			expect(Math.abs(m.dx)).toBeLessThan(0.5);
			expect(Math.abs(m.dy)).toBeLessThan(0.5);
		}
		expect(found.shakeRms).toBeLessThan(0.5);
	});

	it('follows a constant pan with near-zero shake', () => {
		const canvas = world(128, 96);
		const frames: TrackFrame[] = [];
		for (let i = 0; i < 20; i++) frames.push(windowAt(canvas, 128, 2 * i, 16, i / FPS));
		// The 38 px pan pushes left-side content out of frame, so anchors
		// sit right where their content survives the whole pan.
		const found = stabilize(frames, {
			anchors: [
				{ x: 40, y: 12, width: 24, height: 24 },
				{ x: 32, y: 12, width: 24, height: 24 },
				{ x: 24, y: 12, width: 24, height: 24 },
			],
			smoothing: 2,
		});
		expect(found.validFrames).toBe(20);
		found.motion.forEach((m, i) => {
			expect(Math.abs(m.dx - 2 * i)).toBeLessThan(1.5);
			expect(Math.abs(m.dy)).toBeLessThan(1);
		});
		// Interior corrections vanish on a perfectly smooth pan; the
		// truncated Gaussian still bends near the clip edges.
		const interior = found.correction.slice(6, 14);
		const mean = interior.reduce((s, c) => s + Math.abs(c.dx), 0) / interior.length;
		expect(mean).toBeLessThan(0.5);
	});

	it('measures sinusoidal shake and cancels most of it', () => {
		const canvas = world(128, 96);
		const truth: number[] = [];
		const frames: TrackFrame[] = [];
		for (let i = 0; i < 40; i++) {
			const shift = Math.round(8 * Math.sin((2 * Math.PI * i) / 20));
			truth.push(shift);
			frames.push(windowAt(canvas, 128, 40 + shift, 16, i / FPS));
		}
		const found = stabilize(frames, { patches: 3 });
		expect(found.validFrames).toBe(40);
		found.motion.forEach((m, i) => expect(Math.abs(m.dx - truth[i]!)).toBeLessThan(1.5));
		// Stabilized residual: motion minus the applied correction.
		const residual = found.motion.map((m, i) => m.dx - found.correction[i]!.dx);
		expect(rms(residual)).toBeLessThan(rms(truth) * 0.5);
		expect(found.maxCorrection).toBeGreaterThan(5);
	});

	it('reads textureless footage as invalid rather than zero motion', () => {
		const frames: TrackFrame[] = [];
		for (let i = 0; i < 5; i++) frames.push({ gray: new Uint8Array(W * H), width: W, height: H, time: i / FPS });
		const found = stabilize(frames);
		expect(found.patches).toEqual([]);
		expect(found.validFrames).toBe(0);
		expect(found.motion.every((m) => !m.valid)).toBe(true);
	});

	it('ignores an anchor riding a moving subject via the median', () => {
		const canvas = world(128, 96);
		const frames: TrackFrame[] = [];
		for (let i = 0; i < 10; i++) {
			const frame = windowAt(canvas, 128, 20, 16, i / FPS);
			// White square gliding through the third anchor's patch.
			for (let dy = 0; dy < 12; dy++) {
				for (let dx = 0; dx < 12; dx++) frame.gray[(8 + dy) * W + 22 + i * 3 + dx] = 255;
			}
			frames.push(frame);
		}
		const found = stabilize(frames, {
			anchors: [
				{ x: 0, y: 30, width: 16, height: 16 },
				{ x: 48, y: 30, width: 16, height: 16 },
				{ x: 18, y: 4, width: 16, height: 16 },
			],
		});
		expect(found.validFrames).toBe(10);
		for (const m of found.motion) {
			expect(Math.abs(m.dx)).toBeLessThan(1);
			expect(Math.abs(m.dy)).toBeLessThan(1);
		}
	});

	it('refuses one-dimensional texture that would drift (aperture)', () => {
		// Vertical stripes: strong x signal, nothing pinning y.
		const frames: TrackFrame[] = [];
		for (let i = 0; i < 5; i++) {
			const gray = new Uint8Array(W * H);
			for (let y = 0; y < H; y++) {
				for (let x = 0; x < W; x++) gray[y * W + x] = x % 8 < 4 ? 200 : 50;
			}
			frames.push({ gray, width: W, height: H, time: i / FPS });
		}
		const found = stabilize(frames);
		expect(found.patches).toEqual([]);
		expect(found.validFrames).toBe(0);
	});

	it('applies no correction with smoothing disabled', () => {
		const canvas = world(128, 96);
		const frames: TrackFrame[] = [];
		for (let i = 0; i < 10; i++) frames.push(windowAt(canvas, 128, 2 * i, 16, i / FPS));
		const found = stabilize(frames, { patches: 3, smoothing: 0 });
		for (const c of found.correction) {
			expect(c.dx).toBe(0);
			expect(c.dy).toBe(0);
		}
	});

	it('rejects malformed options and empty input', () => {
		const canvas = world(128, 96);
		const frames = [windowAt(canvas, 128, 20, 16, 0)];
		expect(() => stabilize([])).toThrow(/at least one frame/);
		expect(() => stabilize(frames, { patches: 0 })).toThrow(/at least 1 patch/);
		expect(() => stabilize(frames, { patchSize: 2 })).toThrow(/patchSize/);
		expect(() => stabilize(frames, { smoothing: -1 })).toThrow(/smoothing/);
	});
});

describe('motionAt', () => {
	it('finds the nearest sample and returns null without samples', () => {
		const canvas = world(128, 96);
		const frames: TrackFrame[] = [];
		for (let i = 0; i < 10; i++) frames.push(windowAt(canvas, 128, 20, 16, i / FPS));
		const found = stabilize(frames, { patches: 1 });
		expect(motionAt(found.motion, 0.16)!.time).toBeCloseTo(5 / FPS, 10);
		expect(motionAt([], 1)).toBeNull();
	});
});
