/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hard-cut detection over decoded thumbnails: each frame becomes a small
// normalized RGB histogram, consecutive histograms are compared with the
// chi-square distance, and local peaks above the threshold mark cuts. A
// pre/post comparison rejects single-frame flashes (a flash returns to
// the old histogram; a cut does not), and cuts closer than a minimum
// shot length collapse to the strongest. Pure TypeScript, no model —
// thumbnails are small (a 160 px-wide frame is plenty) so whole clips
// scan in milliseconds once decoded.
//
// Honest limits: hard cuts only. Dissolves, fades, and wipes spread
// their change over many frames and stay under the threshold; fast
// whip-pans inside one shot can clear it and read as a cut.

export interface SceneFrame {
	/** Packed RGB bytes, row-major, 3 bytes per pixel. */
	data: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
	/** Presentation time in seconds. */
	time: number;
}

export interface CutDetectOptions {
	/** Histogram bins per RGB channel (bins^3 total). Default 8. */
	bins?: number;
	/** Chi-square distance (0-2) a cut must reach. Default 0.3. */
	threshold?: number;
	/** Cuts closer than this collapse to the strongest. Default 0.4 s. */
	minShotSeconds?: number;
}

export interface Shot {
	index: number;
	/** First frame's time; 0 for the opening shot. */
	start: number;
	/** Last frame's time, or the next cut; the end of footage for the last shot. */
	end: number;
}

export interface CutDetection {
	/** Cut times in seconds, ascending: the first frame of each new shot. */
	cuts: number[];
	/** Shots spanning the analyzed footage; one entry without cuts. */
	shots: Shot[];
	/** Frames analyzed. */
	frames: number;
	/** Last frame's time in seconds (0 without frames). */
	seconds: number;
}

const DEFAULT_BINS = 8;
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_MIN_SHOT_SECONDS = 0.4;
/** A pre/post distance under threshold * FLASH_RATIO reads as a flash, not a cut. */
const FLASH_RATIO = 0.5;

function validateFrame(frame: SceneFrame): void {
	if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
		throw new Error(`detectCuts needs positive integer dimensions, got ${frame.width}x${frame.height}`);
	}
	if (frame.data.length !== frame.width * frame.height * 3) {
		throw new Error(
			`detectCuts needs width*height*3 bytes, got ${frame.data.length} for ${frame.width}x${frame.height}`,
		);
	}
}

function histogramOf(frame: SceneFrame, bins: number): Float64Array {
	const hist = new Float64Array(bins * bins * bins);
	const { data } = frame;
	const scale = bins / 256;
	for (let i = 0; i < data.length; i += 3) {
		const r = Math.min(bins - 1, Math.floor(data[i]! * scale));
		const g = Math.min(bins - 1, Math.floor(data[i + 1]! * scale));
		const b = Math.min(bins - 1, Math.floor(data[i + 2]! * scale));
		hist[(r * bins + g) * bins + b]! += 1;
	}
	const pixels = data.length / 3;
	for (let i = 0; i < hist.length; i++) hist[i]! /= pixels;
	return hist;
}

/**
 * Chi-square distance between two normalized histograms (0 identical,
 * 2 disjoint). Exported for tests and for gradual-transition work that
 * needs the raw frame-to-frame signal.
 */
export function histogramDistance(a: Float64Array, b: Float64Array): number {
	if (a.length !== b.length) throw new Error(`histogramDistance needs equal lengths, got ${a.length} and ${b.length}`);
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const total = a[i]! + b[i]!;
		if (total > 0) {
			const diff = a[i]! - b[i]!;
			sum += (diff * diff) / total;
		}
	}
	return sum;
}

/**
 * Streaming cut detector: push thumbnails in presentation order, read
 * the cuts at the end. Only one histogram per frame is retained, so a
 * whole clip scans without holding its pixels — the decode loop feeds
 * frames and drops them. `result` may be called once, after the last
 * frame; pushing afterwards starts a new scan only via a new scanner.
 */
export class CutScanner {
	private readonly bins: number;
	private readonly threshold: number;
	private readonly minShotSeconds: number;
	private readonly hists: Float64Array[] = [];
	private readonly times: number[] = [];

	constructor(options: CutDetectOptions = {}) {
		const bins = options.bins ?? DEFAULT_BINS;
		const threshold = options.threshold ?? DEFAULT_THRESHOLD;
		const minShotSeconds = options.minShotSeconds ?? DEFAULT_MIN_SHOT_SECONDS;
		if (!Number.isInteger(bins) || bins < 2 || bins > 32) {
			throw new Error(`CutScanner needs bins in 2..32, got ${bins}`);
		}
		if (!(threshold > 0)) throw new Error(`CutScanner needs a positive threshold, got ${threshold}`);
		if (!(minShotSeconds >= 0)) {
			throw new Error(`CutScanner needs a non-negative minShotSeconds, got ${minShotSeconds}`);
		}
		this.bins = bins;
		this.threshold = threshold;
		this.minShotSeconds = minShotSeconds;
	}

	/** Frames pushed so far. */
	get frames(): number {
		return this.hists.length;
	}

	push(frame: SceneFrame): void {
		validateFrame(frame);
		this.hists.push(histogramOf(frame, this.bins));
		this.times.push(frame.time);
	}

	result(): CutDetection {
		const { hists, times, threshold, minShotSeconds } = this;
		const empty: CutDetection = { cuts: [], shots: [], frames: hists.length, seconds: 0 };
		if (!hists.length) return empty;
		const seconds = times[times.length - 1]!;
		if (hists.length < 2) return { cuts: [], shots: [{ index: 0, start: times[0]!, end: seconds }], frames: 1, seconds };

		// distances[i] compares frame i-1 to frame i; distances[0] is unused.
		const distances = [0];
		for (let i = 1; i < hists.length; i++) distances.push(histogramDistance(hists[i - 1]!, hists[i]!));

		const candidates: Array<{ at: number; strength: number }> = [];
		for (let i = 1; i < hists.length; i++) {
			const strength = distances[i]!;
			if (strength < threshold) continue;
			if (strength < distances[i - 1]! || (i + 1 < hists.length && strength < distances[i + 1]!)) continue;
			// Flash rejection, both edges: a one-frame spike differs from both
			// neighbors, so either the frame before the candidate matches the
			// frame after it (rising edge) or the frame before that matches the
			// candidate (falling edge). A real cut matches on neither side.
			const flashFloor = threshold * FLASH_RATIO;
			if (i + 1 < hists.length && histogramDistance(hists[i - 1]!, hists[i + 1]!) < flashFloor) continue;
			if (i > 1 && histogramDistance(hists[i - 2]!, hists[i]!) < flashFloor) continue;
			candidates.push({ at: times[i]!, strength });
		}

		// Collapse cuts closer than a minimum shot, keeping the strongest.
		const cuts: number[] = [];
		for (const candidate of candidates) {
			const prev = cuts[cuts.length - 1];
			if (prev === undefined || candidate.at - prev >= minShotSeconds) {
				cuts.push(candidate.at);
				continue;
			}
			const prevStrength = candidates.find((c) => c.at === prev)!.strength;
			if (candidate.strength > prevStrength) cuts[cuts.length - 1] = candidate.at;
		}

		const bounds = [times[0]!, ...cuts, seconds];
		const shots: Shot[] = [];
		for (let i = 0; i + 1 < bounds.length; i++) shots.push({ index: i, start: bounds[i]!, end: bounds[i + 1]! });
		return { cuts, shots, frames: hists.length, seconds };
	}
}

/**
 * Hard cuts in a thumbnail sequence. Frames must arrive in presentation
 * order. Static footage returns no cuts and a single shot; gradual
 * ramps that never jump between consecutive frames do the same.
 */
export function detectCuts(frames: ReadonlyArray<SceneFrame>, options: CutDetectOptions = {}): CutDetection {
	const scanner = new CutScanner(options);
	for (const frame of frames) scanner.push(frame);
	return scanner.result();
}

/** The shot containing `time` (clamped to the first/last shot outside). */
export function shotAt(shots: ReadonlyArray<Shot>, time: number): Shot | null {
	if (!shots.length) return null;
	let best = shots[0]!;
	for (const shot of shots) {
		if (shot.start <= time) best = shot;
		else break;
	}
	return best;
}

/** The cut nearest `time`, or null without cuts. */
export function nearestCut(cuts: ReadonlyArray<number>, time: number): number | null {
	if (!cuts.length) return null;
	let best = cuts[0]!;
	for (const cut of cuts) {
		if (Math.abs(cut - time) < Math.abs(best - time)) best = cut;
	}
	return best;
}
