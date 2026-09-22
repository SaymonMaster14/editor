/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { TrackFrame } from '@diffusionstudio/track';

// Intelligent reframing analysis: for each frame, the crop window of the
// target aspect that captures the most visual saliency (edge energy plus
// frame-difference motion energy — textured and moving regions read as
// subject), with saliency under 5% of the frame maximum zeroed as noise
// so sensor hiss and codec churn cannot drag the framing off-subject,
// then a Gaussian-smoothed center trajectory so the crop pans instead
// of jumping. The window is the largest of its aspect that fits
// the frame. Smoothing never crosses a cut: each shot gets its own
// trajectory, so a new shot's framing starts fresh instead of dragging
// in from the last shot's subject. An explicit focus track (normalized
// 0-1 points, e.g. from media_track) overrides saliency wherever given.
// Flat frames carry no saliency and read as a centered crop; the
// meanCoverage metric says how much saliency the final trajectory
// actually kept inside the window.
//
// Honest limits: saliency is edges plus motion, not faces, people, text,
// or captions — a high-contrast background sign can outvote a soft-lit
// face, and a static subject on a static background is found by texture
// alone. Translation only: the window never zooms or rotates, and a
// subject wider than the window cannot be kept whole.

export interface FocusPoint {
	time: number;
	/** Focus x as a fraction of frame width, 0-1. */
	x: number;
	/** Focus y as a fraction of frame height, 0-1. */
	y: number;
}

export interface ReframeOptions {
	/** Target aspect as "W:H", e.g. "9:16" or "1:1". Required. */
	aspect: string;
	/** Gaussian smoothing sigma for the crop trajectory, frames. Default 10. 0 disables. */
	smoothing?: number;
	/** Cut times in seconds; smoothing resets across them. Default []. */
	cuts?: number[];
	/** Authoritative focus per time; nearest in time wins. Default: saliency. */
	focus?: FocusPoint[];
}

export interface CropSample {
	time: number;
	/** Crop top-left, integer pixels at the frames' scale. */
	x: number;
	y: number;
	/** Crop size, integer pixels; constant across the analysis. */
	width: number;
	height: number;
}

export interface Reframe {
	/** One crop per analyzed frame, ascending in time. */
	crops: CropSample[];
	/** Frames analyzed. */
	frames: number;
	/** Last frame's time in seconds. */
	seconds: number;
	/** Mean fraction of frame saliency inside the final crop, 0-1. */
	meanCoverage: number;
}

const DEFAULT_SMOOTHING = 10;
/** Saliency under this fraction of the frame maximum reads as noise
 * (sensor hiss, codec churn) and is zeroed, so a uniform noise floor
 * cannot drag the framing off the subject. */
const NOISE_FLOOR_RATIO = 0.05;
/** Windows within this fraction of the best sum are equivalent —
 * one surviving noise pixel must not outvote subject centering. */
const NEAR_TIE_TOL = 1e-3;

function parseAspect(aspect: string): number {
	const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect.trim());
	if (!match) throw new Error(`reframe needs an aspect like "9:16", got ${JSON.stringify(aspect)}`);
	const w = Number(match[1]);
	const h = Number(match[2]);
	if (!(w > 0 && h > 0)) throw new Error(`reframe needs positive aspect parts, got ${JSON.stringify(aspect)}`);
	return w / h;
}

/** Edge energy plus motion energy per pixel; motion is |cur - prev|. */
function saliencyOf(
	cur: Uint8Array | Uint8ClampedArray,
	prev: Uint8Array | Uint8ClampedArray | null,
	width: number,
	height: number,
): Float64Array {
	const sal = new Float64Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const left = cur[y * width + Math.max(0, x - 1)]!;
			const right = cur[y * width + Math.min(width - 1, x + 1)]!;
			const up = cur[Math.max(0, y - 1) * width + x]!;
			const down = cur[Math.min(height - 1, y + 1) * width + x]!;
			const gx = (right - left) / 2;
			const gy = (down - up) / 2;
			const at = y * width + x;
			const diff = prev ? cur[at]! - prev[at]! : 0;
			sal[at] = gx * gx + gy * gy + diff * diff;
		}
	}
	return sal;
}

/** Zeroes saliency under the noise floor; returns the same array. */
function defloor(sal: Float64Array): Float64Array {
	let max = 0;
	for (let k = 0; k < sal.length; k++) if (sal[k]! > max) max = sal[k]!;
	const floor = max * NOISE_FLOOR_RATIO;
	if (!(floor > 0)) {
		sal.fill(0);
		return sal;
	}
	for (let k = 0; k < sal.length; k++) if (sal[k]! < floor) sal[k] = 0;
	return sal;
}

function integralOf(sal: Float64Array, width: number, height: number): Float64Array {
	const table = new Float64Array((width + 1) * (height + 1));
	for (let y = 0; y < height; y++) {
		let row = 0;
		for (let x = 0; x < width; x++) {
			row += sal[y * width + x]!;
			table[(y + 1) * (width + 1) + x + 1] = table[y * (width + 1) + x + 1]! + row;
		}
	}
	return table;
}

function windowSum(table: Float64Array, width: number, x: number, y: number, w: number, h: number): number {
	const stride = width + 1;
	return table[(y + h) * stride + x + w]! - table[(y + h) * stride + x]! - table[y * stride + x + w]! + table[y * stride + x]!;
}

/** Saliency centroid, or null when the frame carries none. */
function centroidOf(sal: Float64Array, width: number, height: number): { x: number; y: number } | null {
	let total = 0;
	let mx = 0;
	let my = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const s = sal[y * width + x]!;
			total += s;
			mx += s * (x + 0.5);
			my += s * (y + 0.5);
		}
	}
	if (!(total > 0)) return null;
	return { x: mx / total, y: my / total };
}

/**
 * Top-left of the ww x wh window holding the most saliency. A small
 * subject swims inside a large window, so exact ties — and near-ties
 * within NEAR_TIE_TOL, which a lone surviving noise pixel creates —
 * break toward the saliency centroid, centering the subject in the
 * crop. The all-zero flat frame has no centroid and reads centered.
 */
function bestWindow(
	table: Float64Array,
	width: number,
	height: number,
	ww: number,
	wh: number,
	centroid: { x: number; y: number } | null,
): { x: number; y: number } {
	const tx = centroid ? centroid.x - ww / 2 : (width - ww) / 2;
	const ty = centroid ? centroid.y - wh / 2 : (height - wh) / 2;
	let best = { x: Math.round(tx), y: Math.round(ty), sum: -1, tie: Infinity };
	for (let y = 0; y + wh <= height; y++) {
		for (let x = 0; x + ww <= width; x++) {
			const sum = windowSum(table, width, x, y, ww, wh);
			const tie = Math.abs(x - tx) + Math.abs(y - ty);
			if (sum > best.sum * (1 + NEAR_TIE_TOL) + 1e-9) {
				best = { x, y, sum, tie };
			} else if (sum >= best.sum * (1 - NEAR_TIE_TOL) - 1e-9 && tie < best.tie) {
				best = { x, y, sum: best.sum, tie };
			}
		}
	}
	return { x: best.x, y: best.y };
}

/** Gaussian smooth of one coordinate within a segment of frames. */
function smoothSegment(values: number[], sigma: number): number[] {
	if (sigma < 0.5) return [...values];
	const radius = Math.ceil(sigma * 3);
	const kernel: number[] = [];
	for (let d = -radius; d <= radius; d++) kernel.push(Math.exp((-d * d) / (2 * sigma * sigma)));
	return values.map((_, i) => {
		let weighted = 0;
		let weights = 0;
		for (let d = -radius; d <= radius; d++) {
			const j = i + d;
			if (j < 0 || j >= values.length) continue;
			const w = kernel[d + radius]!;
			weighted += values[j]! * w;
			weights += w;
		}
		return weighted / weights;
	});
}

function nearestFocus(focus: FocusPoint[], time: number): FocusPoint {
	let best = focus[0]!;
	for (const point of focus) {
		if (Math.abs(point.time - time) < Math.abs(best.time - time)) best = point;
	}
	return best;
}

/**
 * Crop trajectory reframing grayscale frames (presentation order, one
 * size) to `options.aspect`. See the header for the method and its
 * honest limits.
 */
export function reframe(frames: ReadonlyArray<TrackFrame>, options: ReframeOptions): Reframe {
	const smoothing = options.smoothing ?? DEFAULT_SMOOTHING;
	const cuts = [...(options.cuts ?? [])].sort((a, b) => a - b);
	const focus = options.focus ? [...options.focus] : null;
	if (!(smoothing >= 0)) throw new Error(`reframe needs a non-negative smoothing, got ${smoothing}`);
	if (!cuts.every((c) => Number.isFinite(c))) throw new Error('reframe needs finite cut times');
	if (!frames.length) throw new Error('reframe needs at least one frame');
	for (const frame of frames) {
		if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
			throw new Error(`reframe needs positive integer dimensions, got ${frame.width}x${frame.height}`);
		}
		if (frame.gray.length !== frame.width * frame.height) {
			throw new Error(`reframe needs width*height bytes, got ${frame.gray.length} for ${frame.width}x${frame.height}`);
		}
	}
	const { width, height } = frames[0]!;
	if (!frames.every((f) => f.width === width && f.height === height)) {
		throw new Error('reframe needs every frame at one size');
	}
	if (focus) {
		for (const point of focus) {
			if (![point.time, point.x, point.y].every(Number.isFinite)) {
				throw new Error(`reframe needs finite focus points, got ${JSON.stringify(point)}`);
			}
		}
		if (!focus.length) throw new Error('reframe needs a non-empty focus array or none at all');
	}

	const ratio = parseAspect(options.aspect);
	const ww = Math.max(1, Math.min(width, Math.round(height * ratio)));
	const wh = Math.max(1, Math.min(height, Math.round(width / ratio)));

	// Raw per-frame window, from focus where given, else saliency.
	const raw: Array<{ x: number; y: number }> = frames.map((frame, i) => {
		if (focus) {
			const point = nearestFocus(focus, frame.time);
			return {
				x: Math.min(width - ww, Math.max(0, Math.round(point.x * width - ww / 2))),
				y: Math.min(height - wh, Math.max(0, Math.round(point.y * height - wh / 2))),
			};
		}
		const prev = i > 0 ? frames[i - 1]!.gray : null;
		const sal = defloor(saliencyOf(frame.gray, prev, width, height));
		const table = integralOf(sal, width, height);
		return bestWindow(table, width, height, ww, wh, centroidOf(sal, width, height));
	});

	// Smooth the center trajectory per shot: frames at or past a cut
	// start a new segment, so smoothing never drags across a cut.
	const segments: number[][] = [[]];
	frames.forEach((frame, i) => {
		const shot = cuts.filter((c) => c <= frame.time).length;
		while (segments.length <= shot) segments.push([]);
		segments[shot]!.push(i);
	});
	const centers = raw.map((r) => ({ x: r.x + ww / 2, y: r.y + wh / 2 }));
	const smoothed = new Array<{ x: number; y: number }>(frames.length);
	for (const segment of segments) {
		if (!segment.length) continue;
		const xs = smoothSegment(segment.map((i) => centers[i]!.x), smoothing);
		const ys = smoothSegment(segment.map((i) => centers[i]!.y), smoothing);
		segment.forEach((frameIndex, k) => {
			smoothed[frameIndex] = { x: xs[k]!, y: ys[k]! };
		});
	}

	const crops: CropSample[] = frames.map((frame, i) => {
		const center = smoothed[i]!;
		return {
			time: frame.time,
			x: Math.min(width - ww, Math.max(0, Math.round(center.x - ww / 2))),
			y: Math.min(height - wh, Math.max(0, Math.round(center.y - wh / 2))),
			width: ww,
			height: wh,
		};
	});

	// Coverage of the FINAL crop: smoothing may cost saliency, honestly.
	let coverage = 0;
	frames.forEach((frame, i) => {
		const prev = i > 0 ? frames[i - 1]!.gray : null;
		const sal = defloor(saliencyOf(frame.gray, prev, width, height));
		let total = 0;
		for (let k = 0; k < sal.length; k++) total += sal[k]!;
		if (!(total > 0)) {
			coverage += 1;
			return;
		}
		const table = integralOf(sal, width, height);
		const crop = crops[i]!;
		coverage += windowSum(table, width, crop.x, crop.y, crop.width, crop.height) / total;
	});
	return { crops, frames: frames.length, seconds: frames[frames.length - 1]!.time, meanCoverage: coverage / frames.length };
}
