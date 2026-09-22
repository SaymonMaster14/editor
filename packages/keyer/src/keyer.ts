/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SceneFrame } from '@diffusionstudio/scene';

// Chroma-key analysis over decoded RGB frames. The screen color is
// estimated once (median of the frame borders, where backdrops live
// and subjects rarely do) or passed explicitly; each pixel's alpha is
// its RGB distance from the screen mapped through a tolerance/softness
// ramp, so near-screen pixels go transparent, far pixels stay solid,
// and the band between feathers the edge. Despill then clamps the
// screen-dominant channel on foreground pixels toward the other two,
// killing green fringes without graying the subject. An optional
// one-pass box soften smooths matte chatter, and garbage boxes force
// regions (rigs, stands, edges of an imperfect cyc) to background.
// The verdict reads the key honestly: a near-gray estimated screen is
// "weak-screen" (nothing to key), heavy semi-transparency is "noisy",
// otherwise "clean".
//
// Honest limits: one global screen color — unevenly lit cycs key
// partially, and screen-colored costumes, props, and eye reflections
// key along with the backdrop. Shadows on the screen and motion-blurred
// edges read as foreground or fringe. This is analysis plus mattes,
// not a finished compositor: no light wrap, no edge color recovery.

/** RGB channel triple, 0-255. */
export type Rgb = [number, number, number];

/** Box corners in pixels at the frames' scale. */
export interface KeyBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface KeyOptions {
	/** Screen color; estimated from borders when omitted. */
	screen?: Rgb;
	/** Distance under this keys fully. Default 60. */
	tolerance?: number;
	/** Width of the feather band past tolerance. Default 40. */
	softness?: number;
	/** Clamp screen-channel spill on foreground. Default true. */
	despill?: boolean;
	/** Box-blur passes over the matte (0-2). Default 1. */
	soften?: number;
	/** Regions forced to background. Default []. */
	garbage?: KeyBox[];
}

export interface KeyVerdict {
	verdict: 'clean' | 'weak-screen' | 'noisy';
	/** Estimated or given screen color. */
	screen: Rgb;
	/** Saturation of the screen, 0-1: low means nothing to key. */
	screenSaturation: number;
}

export interface MatteSample {
	time: number;
	/** Fraction of pixels fully foreground (alpha 255). */
	fgFraction: number;
	/** Fraction of pixels semi-transparent (the feather band). */
	edgeFraction: number;
	/** Fraction of foreground pixels the despill touched. */
	spillFraction: number;
}

export interface KeyAnalysis extends KeyVerdict {
	/** One sample per analyzed frame, ascending in time. */
	samples: MatteSample[];
	/** Mean foreground fraction across frames. */
	meanFg: number;
	/** Mean edge fraction across frames. */
	meanEdge: number;
	frames: number;
	seconds: number;
}

export interface Matte {
	/** Alpha bytes, row-major: 255 foreground, 0 screen. */
	alpha: Uint8Array;
	/** Despilled RGB bytes, row-major; a copy of the input when despill is off. */
	rgb: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
}

const DEFAULT_TOLERANCE = 60;
const DEFAULT_SOFTNESS = 40;
/** Screen saturation under this is gray, not a screen. */
const MIN_SCREEN_SATURATION = 0.15;
/** Mean edge fraction past this reads as a noisy key. */
const MAX_EDGE_FRACTION = 0.3;
/** Border strip width (px) the screen estimate samples. */
const BORDER = 8;

function clampByte(v: number): number {
	return Math.min(255, Math.max(0, Math.round(v)));
}

function validateOptions(options: KeyOptions): void {
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	const softness = options.softness ?? DEFAULT_SOFTNESS;
	const soften = options.soften ?? 1;
	if (!(tolerance >= 0)) throw new Error(`key needs a non-negative tolerance, got ${tolerance}`);
	if (!(softness > 0)) throw new Error(`key needs a positive softness, got ${softness}`);
	if (!Number.isInteger(soften) || soften < 0 || soften > 2) {
		throw new Error(`key needs soften 0-2, got ${soften}`);
	}
	if (options.screen && (!options.screen.every((c) => Number.isFinite(c) && c >= 0 && c <= 255) || options.screen.length !== 3)) {
		throw new Error(`key needs an RGB screen triple, got ${JSON.stringify(options.screen)}`);
	}
	for (const box of options.garbage ?? []) {
		if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 0 || box.height < 0) {
			throw new Error(`key needs finite garbage boxes, got ${JSON.stringify(box)}`);
		}
	}
}

function validateFrame(frame: SceneFrame): void {
	if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
		throw new Error(`key needs positive integer dimensions, got ${frame.width}x${frame.height}`);
	}
	if (frame.data.length !== frame.width * frame.height * 3) {
		throw new Error(`key needs width*height*3 bytes, got ${frame.data.length} for ${frame.width}x${frame.height}`);
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Screen color as the per-channel median of the frame borders: the
 * median ignores a subject leaning into one edge, but a subject
 * covering most of the border wins the vote, honestly reported.
 */
function estimateScreenFrom(frame: SceneFrame): Rgb {
	const { data, width, height } = frame;
	const edge = Math.min(BORDER, Math.floor(Math.min(width, height) / 4));
	const rs: number[] = [];
	const gs: number[] = [];
	const bs: number[] = [];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (x >= edge && y >= edge && x < width - edge && y < height - edge) continue;
			const at = (y * width + x) * 3;
			rs.push(data[at]!);
			gs.push(data[at + 1]!);
			bs.push(data[at + 2]!);
		}
	}
	return [median(rs), median(gs), median(bs)];
}

/** Saturation 0-1: (max-min)/max, 0 for black. */
export function saturationOf([r, g, b]: Rgb): number {
	const mx = Math.max(r, g, b);
	if (!(mx > 0)) return 0;
	return (mx - Math.min(r, g, b)) / mx;
}

function distanceOf(r: number, g: number, b: number, [sr, sg, sb]: Rgb): number {
	return Math.sqrt((r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2);
}

function inGarbage(x: number, y: number, garbage: KeyBox[]): boolean {
	return garbage.some((box) => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height);
}

/** One 3x3 box pass over the matte, in place. */
function softenMatte(alpha: Uint8Array, width: number, height: number): void {
	const src = alpha.slice();
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			let n = 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					const yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
					sum += src[yy * width + xx]!;
					n++;
				}
			}
			alpha[y * width + x] = Math.round(sum / n);
		}
	}
}

/**
 * Alpha matte plus despilled RGB for one RGB frame:
 * distance-from-screen through the tolerance/softness ramp, despilled,
 * softened, garbage-cut. Returns the matte plus this frame's sample;
 * the despill count reflects the pre-soften matte, since softening
 * only reshapes edges.
 */
export function keyFrame(frame: SceneFrame, screen: Rgb, options: KeyOptions = {}): { matte: Matte; sample: MatteSample } {
	validateFrame(frame);
	validateOptions({ ...options, screen });
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	const softness = options.softness ?? DEFAULT_SOFTNESS;
	const despill = options.despill ?? true;
	const soften = options.soften ?? 1;
	const garbage = options.garbage ?? [];
	const { data, width, height } = frame;
	const dominant = screen.indexOf(Math.max(...screen));

	const alpha = new Uint8Array(width * height);
	const rgb = new Uint8Array(data);
	let fg = 0;
	let edge = 0;
	let spill = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = y * width + x;
			if (inGarbage(x, y, garbage)) {
				alpha[at] = 0;
				continue;
			}
			const px = at * 3;
			const r = data[px]!;
			const g = data[px + 1]!;
			const b = data[px + 2]!;
			const dist = distanceOf(r, g, b, screen);
			const a = dist <= tolerance ? 0 : dist >= tolerance + softness ? 255 : Math.round(((dist - tolerance) / softness) * 255);
			if (a === 255) {
				fg++;
				if (despill) {
					const channels = [r, g, b];
					const cap = Math.max(...channels.filter((_, i) => i !== dominant)) + tolerance / 4;
					if (channels[dominant]! > cap) {
						rgb[px + dominant] = clampByte(cap);
						spill++;
					}
				}
			} else if (a > 0) {
				edge++;
			}
			alpha[at] = a;
		}
	}
	for (let p = 0; p < soften; p++) softenMatte(alpha, width, height);
	const total = width * height;
	return {
		matte: { alpha, rgb, width, height },
		sample: { time: frame.time, fgFraction: fg / total, edgeFraction: edge / total, spillFraction: fg ? spill / fg : 0 },
	};
}

/**
 * Key quality for RGB frames in presentation order at one size: the
 * screen estimate, per-frame matte samples, means, and the verdict.
 * Use keyFrame for the mattes themselves.
 */
export function keyClip(frames: ReadonlyArray<SceneFrame>, options: KeyOptions = {}): KeyAnalysis {
	if (!frames.length) throw new Error('key needs at least one frame');
	for (const frame of frames) validateFrame(frame);
	const { width, height } = frames[0]!;
	if (!frames.every((f) => f.width === width && f.height === height)) {
		throw new Error('key needs every frame at one size');
	}
	validateOptions(options);
	const screen = options.screen ?? estimateScreenFrom(frames[0]!);
	const screenSaturation = saturationOf(screen.map(clampByte) as Rgb);

	const samples: MatteSample[] = frames.map((frame) => keyFrame(frame, screen, options).sample);
	const meanFg = samples.reduce((s, m) => s + m.fgFraction, 0) / samples.length;
	const meanEdge = samples.reduce((s, m) => s + m.edgeFraction, 0) / samples.length;
	const verdict = screenSaturation < MIN_SCREEN_SATURATION ? 'weak-screen' : meanEdge > MAX_EDGE_FRACTION ? 'noisy' : 'clean';
	return { verdict, screen, screenSaturation, samples, meanFg, meanEdge, frames: frames.length, seconds: frames[frames.length - 1]!.time };
}
