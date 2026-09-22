/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Point tracking by template matching: the keyframe's box becomes a fixed
// grayscale template, and every other frame is searched around the last
// known position for its best normalized cross-correlation (NCC) match —
// brightness similarity when the box is textureless, since NCC divides
// by zero there. Fixed template, no online update: the track cannot
// drift onto the background, and the confidence (the match peak) honestly
// reports how template-like the match still is. Frames under the lost
// threshold keep the last position and read as lost, so occlusions do
// not teleport the track and recovery is automatic when the subject
// returns. The scan runs forward from the keyframe to the end and
// backward to the start, so one keyframe yields a whole-clip track.
// Pure TypeScript, no model.
//
// Honest limits: translation only — scale, rotation, and perspective are
// not followed, and a subject that changes size in frame sheds confidence
// as it does. Integer-pixel positions at the decoded scan scale. Fast
// motion past the search radius loses the track instead of guessing.
// Flat templates on flat regions are ambiguous: include background
// margin in the box when the subject itself is textureless.

export interface TrackFrame {
	/** Grayscale bytes, row-major, 1 byte per pixel. */
	gray: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
	/** Presentation time in seconds. */
	time: number;
}

/** Box corners in pixels at the frames' scale. */
export interface PixelBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface TrackOptions {
	/** Search radius around the last position, pixels. Default 24. */
	searchRadius?: number;
	/** NCC peak under this reads as lost. Default 0.6. */
	lostThreshold?: number;
}

export interface TrackSample {
	time: number;
	/** Box-center x as a fraction of frame width, 0-1. */
	x: number;
	/** Box-center y as a fraction of frame height, 0-1. */
	y: number;
	/** NCC peak at the reported position, -1 to 1. */
	confidence: number;
	/** True when confidence fell under the lost threshold. */
	lost: boolean;
}

export interface PointTrack {
	/** One sample per analyzed frame, ascending in time. */
	samples: TrackSample[];
	/** Index of the keyframe the template came from. */
	keyframe: number;
	frames: number;
	seconds: number;
}

const DEFAULT_SEARCH_RADIUS = 24;
const DEFAULT_LOST_THRESHOLD = 0.6;

function validateFrame(frame: TrackFrame): void {
	if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
		throw new Error(`trackPoint needs positive integer dimensions, got ${frame.width}x${frame.height}`);
	}
	if (frame.gray.length !== frame.width * frame.height) {
		throw new Error(`trackPoint needs width*height bytes, got ${frame.gray.length} for ${frame.width}x${frame.height}`);
	}
}

function validateBox(box: PixelBox, width: number, height: number): void {
	const { x, y, width: w, height: h } = box;
	if (![x, y, w, h].every((v) => Number.isFinite(v))) throw new Error(`trackPoint needs a finite box, got ${JSON.stringify(box)}`);
	if (!(w >= 4 && h >= 4)) throw new Error(`trackPoint needs a box of at least 4x4 px, got ${w}x${h}`);
	if (!(x >= 0 && y >= 0 && x + w <= width && y + h <= height)) {
		throw new Error(`trackPoint box ${JSON.stringify(box)} falls outside the ${width}x${height} frame`);
	}
}

/** Integral images (sum and sum of squares) for O(1) patch statistics. */
function integrals(gray: Uint8Array | Uint8ClampedArray, width: number, height: number): { sum: Float64Array; sq: Float64Array } {
	const sum = new Float64Array((width + 1) * (height + 1));
	const sq = new Float64Array((width + 1) * (height + 1));
	for (let y = 0; y < height; y++) {
		let row = 0;
		let rowSq = 0;
		for (let x = 0; x < width; x++) {
			const v = gray[y * width + x]!;
			row += v;
			rowSq += v * v;
			const at = (y + 1) * (width + 1) + x + 1;
			sum[at] = sum[at - width - 1]! + row;
			sq[at] = sq[at - width - 1]! + rowSq;
		}
	}
	return { sum, sq };
}

function patchStats(
	tables: { sum: Float64Array; sq: Float64Array },
	width: number,
	x: number,
	y: number,
	w: number,
	h: number,
): { mean: number; std: number } {
	const stride = width + 1;
	const { sum, sq } = tables;
	const s = sum[(y + h) * stride + x + w]! - sum[(y + h) * stride + x]! - sum[y * stride + x + w]! + sum[y * stride + x]!;
	const q = sq[(y + h) * stride + x + w]! - sq[(y + h) * stride + x]! - sq[y * stride + x + w]! + sq[y * stride + x]!;
	const n = w * h;
	const mean = s / n;
	return { mean, std: Math.sqrt(Math.max(0, q / n - mean * mean)) };
}

function templateStats(tmpl: Float64Array): { mean: number; std: number } {
	let s = 0;
	for (let i = 0; i < tmpl.length; i++) s += tmpl[i]!;
	const mean = s / tmpl.length;
	let v = 0;
	for (let i = 0; i < tmpl.length; i++) v += (tmpl[i]! - mean) ** 2;
	return { mean, std: Math.sqrt(v / tmpl.length) };
}

/**
 * Best match for the template inside the search window, as top-left
 * pixels plus the peak. Textured templates match by NCC; flat ones
 * (a tight box on a solid object) fall back to brightness similarity,
 * since NCC divides by zero there. A peak tied across most of the
 * window is ambiguity, not a match — flat template on a flat frame —
 * and scores 0 at the last position rather than a confident guess.
 */
function matchTemplate(
	gray: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	tmpl: Float64Array,
	tw: number,
	th: number,
	tMean: number,
	tStd: number,
	cx: number,
	cy: number,
	radius: number,
): { x: number; y: number; peak: number } {
	const tables = integrals(gray, width, height);
	const flat = tStd < 1e-9;
	const n = tw * th;
	let best = { x: cx, y: cy, peak: -Infinity };
	let ties = 0;
	let total = 0;
	for (let y = Math.max(0, cy - radius); y <= Math.min(height - th, cy + radius); y++) {
		for (let x = Math.max(0, cx - radius); x <= Math.min(width - tw, cx + radius); x++) {
			total++;
			let score: number;
			if (flat) {
				let sad = 0;
				for (let ty = 0; ty < th; ty++) {
					const row = (y + ty) * width + x;
					const trow = ty * tw;
					for (let tx = 0; tx < tw; tx++) sad += Math.abs(gray[row + tx]! - tmpl[trow + tx]!);
				}
				score = 1 - sad / n / 255;
			} else {
				const { mean: pMean, std: pStd } = patchStats(tables, width, x, y, tw, th);
				if (pStd < 1e-9) {
					score = 0;
				} else {
					let cross = 0;
					for (let ty = 0; ty < th; ty++) {
						const row = (y + ty) * width + x;
						const trow = ty * tw;
						for (let tx = 0; tx < tw; tx++) cross += gray[row + tx]! * tmpl[trow + tx]!;
					}
					score = (cross - n * tMean * pMean) / (n * tStd * pStd);
				}
			}
			if (score > best.peak + 1e-9) {
				best = { x, y, peak: score };
				ties = 1;
			} else if (score >= best.peak - 1e-9) {
				ties++;
			}
		}
	}
	if (!total || (total > 1 && ties > total / 2)) return { x: cx, y: cy, peak: 0 };
	return best;
}

/**
 * Follows `box` (pixels at the frames' scale) from the frame nearest
 * `at` across the whole clip. Frames must arrive in presentation order
 * and share one size. Returns one sample per frame, ascending in time.
 */
export function trackPoint(frames: ReadonlyArray<TrackFrame>, box: PixelBox, at: number, options: TrackOptions = {}): PointTrack {
	const searchRadius = options.searchRadius ?? DEFAULT_SEARCH_RADIUS;
	const lostThreshold = options.lostThreshold ?? DEFAULT_LOST_THRESHOLD;
	if (!Number.isFinite(searchRadius) || searchRadius < 0) {
		throw new Error(`trackPoint needs a non-negative searchRadius, got ${searchRadius}`);
	}
	if (!Number.isFinite(at)) throw new Error(`trackPoint needs a finite keyframe time, got ${at}`);
	if (!frames.length) throw new Error('trackPoint needs at least one frame');
	for (const frame of frames) validateFrame(frame);
	const { width, height } = frames[0]!;
	if (!frames.every((f) => f.width === width && f.height === height)) {
		throw new Error('trackPoint needs every frame at one size');
	}

	// Integer box, clamped to whole pixels: the template is pixel data.
	const key: PixelBox = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
	validateBox(key, width, height);

	let keyframe = 0;
	for (let i = 1; i < frames.length; i++) {
		if (Math.abs(frames[i]!.time - at) < Math.abs(frames[keyframe]!.time - at)) keyframe = i;
	}

	const tmpl = new Float64Array(key.width * key.height);
	const keyGray = frames[keyframe]!.gray;
	for (let ty = 0; ty < key.height; ty++) {
		for (let tx = 0; tx < key.width; tx++) tmpl[ty * key.width + tx] = keyGray[(key.y + ty) * width + key.x + tx]!;
	}
	const { mean: tMean, std: tStd } = templateStats(tmpl);

	const positions: Array<{ x: number; y: number; peak: number }> = new Array(frames.length);
	// The keyframe earns its confidence like any other frame: the box
	// pins the position, but only a uniquely winning peak there counts.
	// A flat template on a flat frame, or an identical pattern nearby,
	// reads as lost — the template cannot be told apart, honestly.
	const keySrc = frames[keyframe]!;
	const keyMatch = matchTemplate(keySrc.gray, width, height, tmpl, key.width, key.height, tMean, tStd, key.x, key.y, searchRadius);
	positions[keyframe] = keyMatch.x === key.x && keyMatch.y === key.y ? keyMatch : { x: key.x, y: key.y, peak: 0 };
	const passes: ReadonlyArray<'forward' | 'backward'> = ['forward', 'backward'];
	for (const pass of passes) {
		let cx = key.x;
		let cy = key.y;
		const indices: number[] = [];
		if (pass === 'forward') for (let i = keyframe + 1; i < frames.length; i++) indices.push(i);
		else for (let i = keyframe - 1; i >= 0; i--) indices.push(i);
		for (const i of indices) {
			const frame = frames[i]!;
			const found = matchTemplate(frame.gray, width, height, tmpl, key.width, key.height, tMean, tStd, cx, cy, searchRadius);
			if (found.peak >= lostThreshold) {
				cx = found.x;
				cy = found.y;
			}
			// Lost frames hold the last position with the sub-threshold
			// peak, so occlusions neither teleport the track nor poison it.
			positions[i] = { x: cx, y: cy, peak: found.peak };
		}
	}

	const samples: TrackSample[] = frames.map((frame, i) => {
		const pos = positions[i]!;
		return {
			time: frame.time,
			x: (pos.x + key.width / 2) / width,
			y: (pos.y + key.height / 2) / height,
			confidence: pos.peak,
			lost: pos.peak < lostThreshold,
		};
	});
	return { samples, keyframe, frames: frames.length, seconds: frames[frames.length - 1]!.time };
}

/** The sample nearest `time`, or null without samples. */
export function sampleAt(samples: ReadonlyArray<TrackSample>, time: number): TrackSample | null {
	if (!samples.length) return null;
	let best = samples[0]!;
	for (const sample of samples) {
		if (Math.abs(sample.time - time) < Math.abs(best.time - time)) best = sample;
	}
	return best;
}
