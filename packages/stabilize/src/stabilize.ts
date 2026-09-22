/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trackPoint } from '@diffusionstudio/track';

import type { PixelBox, TrackFrame } from '@diffusionstudio/track';

// Translation stabilization analysis: several textured anchor patches are
// tracked across the clip, and the per-frame MEDIAN of their displacements
// reads as the camera position — the median follows the background while
// ignoring patches that drifted onto moving subjects or got lost. A
// Gaussian smooth of that trajectory is the intended camera path; the
// per-frame correction (raw minus smooth) is the frame translation a
// renderer applies to cancel the shake. Translation only, integer
// pixels at the scan scale.
// Textureless footage yields no anchors and reads as invalid throughout
// rather than a fabricated zero-motion track.

export interface StabilizeOptions {
	/** Anchor patches to track and median. Default 5. */
	patches?: number;
	/** Anchor patch edge, pixels. Default 24. */
	patchSize?: number;
	/** Search radius per patch track, pixels. Default 12. */
	searchRadius?: number;
	/** Gaussian smoothing sigma, frames. Default 30. 0 disables smoothing. */
	smoothing?: number;
	/** Keyframe time the anchors are picked on. Default 0. */
	at?: number;
	/** Explicit anchors, overriding auto-pick (box pixels at frame scale). */
	anchors?: PixelBox[];
}

export interface MotionSample {
	time: number;
	/** Camera x relative to the keyframe, pixels: the negation of the
	 * measured content displacement. 0 when invalid. */
	dx: number;
	/** Camera y relative to the keyframe, pixels. 0 when invalid. */
	dy: number;
	/** False when no anchor tracked this frame. */
	valid: boolean;
}

export interface CorrectionSample {
	time: number;
	/** Translate the frame by (dx, dy) pixels to stabilize. 0 when invalid. */
	dx: number;
	dy: number;
	valid: boolean;
}

export interface Stabilization {
	/** Raw camera position per frame, ascending in time. */
	motion: MotionSample[];
	/** Per-frame stabilizing correction, ascending in time. */
	correction: CorrectionSample[];
	/** Anchors the estimate stands on; empty when unmeasurable. */
	patches: PixelBox[];
	keyframe: number;
	/** RMS(raw − smooth) over valid frames, pixels: the removed shake. */
	shakeRms: number;
	/** Largest correction magnitude over valid frames, pixels. */
	maxCorrection: number;
	validFrames: number;
	frames: number;
	seconds: number;
}

const DEFAULT_PATCHES = 5;
const DEFAULT_PATCH_SIZE = 24;
const DEFAULT_SEARCH_RADIUS = 12;
const DEFAULT_SMOOTHING = 30;
/** Anchors need texture in BOTH directions: below this gradient variance
 * a patch cannot be tracked (a bar edge pins x while y drifts freely —
 * the aperture problem). Scored as the weaker of the two axes. */
const MIN_GRADIENT_VARIANCE = 50;

function gradients(gray: Uint8Array | Uint8ClampedArray, width: number, height: number): { gx: Float64Array; gy: Float64Array } {
	const gx = new Float64Array(width * height);
	const gy = new Float64Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const left = gray[y * width + Math.max(0, x - 1)]!;
			const right = gray[y * width + Math.min(width - 1, x + 1)]!;
			const up = gray[Math.max(0, y - 1) * width + x]!;
			const down = gray[Math.min(height - 1, y + 1) * width + x]!;
			gx[y * width + x] = (right - left) / 2;
			gy[y * width + x] = (down - up) / 2;
		}
	}
	return { gx, gy };
}

/** Weaker-axis gradient variance: texture in x alone scores nothing. */
function patchScore(gx: Float64Array, gy: Float64Array, width: number, x: number, y: number, size: number): number {
	let sx = 0;
	let sy = 0;
	for (let dy = 0; dy < size; dy++) {
		const row = (y + dy) * width + x;
		for (let dx = 0; dx < size; dx++) {
			sx += gx[row + dx]!;
			sy += gy[row + dx]!;
		}
	}
	const n = size * size;
	const mx = sx / n;
	const my = sy / n;
	let vx = 0;
	let vy = 0;
	for (let dy = 0; dy < size; dy++) {
		const row = (y + dy) * width + x;
		for (let dx = 0; dx < size; dx++) {
			vx += (gx[row + dx]! - mx) ** 2;
			vy += (gy[row + dx]! - my) ** 2;
		}
	}
	return Math.min(vx / n, vy / n);
}

function overlaps(a: PixelBox, b: PixelBox): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Best two-axis-textured non-overlapping patches on the keyframe, best first. */
function pickAnchors(gray: Uint8Array | Uint8ClampedArray, width: number, height: number, count: number, size: number): PixelBox[] {
	const { gx, gy } = gradients(gray, width, height);
	const stride = Math.max(4, Math.floor(size / 2));
	const candidates: Array<{ box: PixelBox; score: number }> = [];
	for (let y = 0; y + size <= height; y += stride) {
		for (let x = 0; x + size <= width; x += stride) {
			const score = patchScore(gx, gy, width, x, y, size);
			if (score >= MIN_GRADIENT_VARIANCE) candidates.push({ box: { x, y, width: size, height: size }, score });
		}
	}
	candidates.sort((a, b) => b.score - a.score);
	const anchors: PixelBox[] = [];
	for (const candidate of candidates) {
		if (anchors.length >= count) break;
		if (!anchors.some((kept) => overlaps(kept, candidate.box))) anchors.push(candidate.box);
	}
	return anchors;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Gaussian smooth over valid samples (normalized convolution: invalid
 * samples simply carry no weight). A sample with no valid neighbor in
 * reach stays invalid.
 */
function smooth(valid: boolean[], values: number[], sigma: number): Array<{ value: number; valid: boolean }> {
	if (sigma < 0.5) return values.map((value, i) => ({ value, valid: valid[i]! }));
	const radius = Math.ceil(sigma * 3);
	const kernel: number[] = [];
	for (let d = -radius; d <= radius; d++) kernel.push(Math.exp((-d * d) / (2 * sigma * sigma)));
	return values.map((_, i) => {
		let weighted = 0;
		let weights = 0;
		for (let d = -radius; d <= radius; d++) {
			const j = i + d;
			if (j < 0 || j >= values.length || !valid[j]) continue;
			const w = kernel[d + radius]!;
			weighted += values[j]! * w;
			weights += w;
		}
		if (!weights) return { value: 0, valid: false };
		return { value: weighted / weights, valid: true };
	});
}

/**
 * Camera motion and stabilizing corrections for grayscale frames in
 * presentation order at one size. See the header for the method and
 * its honest limits.
 */
export function stabilize(frames: ReadonlyArray<TrackFrame>, options: StabilizeOptions = {}): Stabilization {
	const patchCount = options.patches ?? DEFAULT_PATCHES;
	const patchSize = options.patchSize ?? DEFAULT_PATCH_SIZE;
	const searchRadius = options.searchRadius ?? DEFAULT_SEARCH_RADIUS;
	const smoothing = options.smoothing ?? DEFAULT_SMOOTHING;
	const at = options.at ?? 0;
	if (!Number.isInteger(patchCount) || patchCount < 1) {
		throw new Error(`stabilize needs at least 1 patch, got ${patchCount}`);
	}
	if (!Number.isInteger(patchSize) || patchSize < 4) {
		throw new Error(`stabilize needs a patchSize of at least 4 px, got ${patchSize}`);
	}
	if (!(smoothing >= 0)) throw new Error(`stabilize needs a non-negative smoothing, got ${smoothing}`);
	if (!frames.length) throw new Error('stabilize needs at least one frame');

	const key = frames[0]!;
	if (key.gray.length !== key.width * key.height) {
		throw new Error(`stabilize needs width*height bytes, got ${key.gray.length} for ${key.width}x${key.height}`);
	}
	const empty: Stabilization = {
		motion: frames.map((f) => ({ time: f.time, dx: 0, dy: 0, valid: false })),
		correction: frames.map((f) => ({ time: f.time, dx: 0, dy: 0, valid: false })),
		patches: [],
		keyframe: 0,
		shakeRms: 0,
		maxCorrection: 0,
		validFrames: 0,
		frames: frames.length,
		seconds: frames[frames.length - 1]!.time,
	};

	const anchors = options.anchors ?? pickAnchors(key.gray, key.width, key.height, patchCount, patchSize);
	if (!anchors.length) return { ...empty, keyframe: 0 };

	const tracks = anchors.map((box) => trackPoint(frames, box, at, { searchRadius }));
	const keyframe = tracks[0]!.keyframe;
	const keyX = tracks.map((t) => t.samples[keyframe]!.x);
	const keyY = tracks.map((t) => t.samples[keyframe]!.y);

	const motion: MotionSample[] = frames.map((frame, i) => {
		const dxs: number[] = [];
		const dys: number[] = [];
		tracks.forEach((track, p) => {
			const sample = track.samples[i]!;
			if (!sample.lost) {
				dxs.push((sample.x - keyX[p]!) * key.width);
				dys.push((sample.y - keyY[p]!) * key.height);
			}
		});
		if (!dxs.length) return { time: frame.time, dx: 0, dy: 0, valid: false };
		// Content displacement negated: the camera went the other way.
		return { time: frame.time, dx: -median(dxs), dy: -median(dys), valid: true };
	});

	const valid = motion.map((m) => m.valid);
	const smoothX = smooth(valid, motion.map((m) => m.dx), smoothing);
	const smoothY = smooth(valid, motion.map((m) => m.dy), smoothing);
	const correction: CorrectionSample[] = frames.map((frame, i) => {
		const sx = smoothX[i]!;
		const sy = smoothY[i]!;
		if (!motion[i]!.valid || !sx.valid || !sy.valid) return { time: frame.time, dx: 0, dy: 0, valid: false };
		// Shift the frame with the unwanted camera offset: raw minus smooth.
		return { time: frame.time, dx: motion[i]!.dx - sx.value, dy: motion[i]!.dy - sy.value, valid: true };
	});

	let shake = 0;
	let peak = 0;
	let validFrames = 0;
	correction.forEach((c) => {
		if (!c.valid) return;
		validFrames++;
		shake += c.dx * c.dx + c.dy * c.dy;
		peak = Math.max(peak, Math.hypot(c.dx, c.dy));
	});
	return {
		motion,
		correction,
		patches: anchors,
		keyframe,
		shakeRms: validFrames ? Math.sqrt(shake / validFrames) : 0,
		maxCorrection: peak,
		validFrames,
		frames: frames.length,
		seconds: frames[frames.length - 1]!.time,
	};
}

/** The motion sample nearest `time`, or null without samples. */
export function motionAt(samples: ReadonlyArray<MotionSample>, time: number): MotionSample | null {
	if (!samples.length) return null;
	let best = samples[0]!;
	for (const sample of samples) {
		if (Math.abs(sample.time - time) < Math.abs(best.time - time)) best = sample;
	}
	return best;
}
