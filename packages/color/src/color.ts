/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SceneFrame } from '@diffusionstudio/scene';

// Color finishing math, tier 1: scopes analysis plus byte-space grade
// operations. Scopes read what is there — luma mean and spread,
// clipped black/white fractions, per-channel means, a cast read, a
// 32-bin luma histogram and 32-bin RGB histograms, and 8-band luma
// waveform min/max strips — and reduce the clip to one verdict:
// clipped-white, clipped-black, cast, flat, or balanced, in that
// priority, with the numbers behind it. Grades apply in a fixed
// documented order (lift/gain/gamma, exposure, contrast, saturation,
// temperature) over 0-255 bytes and return new frames.
//
// Honest limits: everything runs in byte space, not scene-linear,
// with Rec.709 luma — no OpenColorIO, no color management, no LUTs
// yet. Temperature is a simple red/blue seesaw, not a Kelvin black
// body locus. The verdict names the dominant issue only; the fractions
// carry the full story. Scopes verdicts describe pixels, not taste.

export interface GradeParams {
	/** Exposure in stops, -5..5. Default 0. */
	exposure?: number;
	/** Contrast multiplier around mid-gray, 0..4. Default 1. */
	contrast?: number;
	/** Saturation multiplier, 0..4. Default 1. */
	saturation?: number;
	/** Warm (>0) / cool (<0) seesaw, -1..1. Default 0. */
	temperature?: number;
	/** Per-channel lift added, -1..1 each. Default [0,0,0]. */
	lift?: [number, number, number];
	/** Per-channel gain multiplier, 0..4 each. Default [1,1,1]. */
	gain?: [number, number, number];
	/** Per-channel gamma exponent, 0.1..4 each. Default [1,1,1]. */
	gamma?: [number, number, number];
}

export interface ScopesSample {
	time: number;
	meanLuma: number;
	lumaStd: number;
	clippedBlack: number;
	clippedWhite: number;
	channelMeans: [number, number, number];
	castToward: 'red' | 'green' | 'blue' | 'none';
	castStrength: number;
	/** 32-bin luma histogram, counts. */
	lumaHist: number[];
	/** 32-bin per-channel histograms, counts. */
	rgbHist: [number[], number[], number[]];
	/** 8 horizontal waveform strips as [min,max] luma pairs. */
	waveform: Array<[number, number]>;
}

export type ScopesVerdict = 'balanced' | 'clipped-black' | 'clipped-white' | 'cast' | 'flat';

export interface ScopesAnalysis {
	samples: ScopesSample[];
	verdict: ScopesVerdict;
	meanLuma: number;
	meanClippedBlack: number;
	meanClippedWhite: number;
	meanCastStrength: number;
	frames: number;
	seconds: number;
}

const HIST_BINS = 32;
const WAVE_BANDS = 8;
const BLACK_LEVEL = 4;
const WHITE_LEVEL = 251;
const CLIP_FRACTION = 0.02;
const CAST_FRACTION = 0.15;
const CAST_NONE = 0.05;
const FLAT_STD = 8;

function clampByte(v: number): number {
	return Math.min(255, Math.max(0, Math.round(v)));
}

function lumaOf(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function validateFrames(frames: ReadonlyArray<SceneFrame>): void {
	if (!frames.length) throw new Error('color needs at least one frame');
	for (const frame of frames) {
		if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
			throw new Error(`color needs positive integer dimensions, got ${frame.width}x${frame.height}`);
		}
		if (frame.data.length !== frame.width * frame.height * 3) {
			throw new Error(`color needs width*height*3 bytes, got ${frame.data.length} for ${frame.width}x${frame.height}`);
		}
	}
	const { width, height } = frames[0]!;
	if (!frames.every((f) => f.width === width && f.height === height)) {
		throw new Error('color needs every frame at one size');
	}
}

function inRange(v: number, lo: number, hi: number): boolean {
	return Number.isFinite(v) && v >= lo && v <= hi;
}

function validateGrade(params: GradeParams): void {
	const { exposure = 0, contrast = 1, saturation = 1, temperature = 0 } = params;
	const lift = params.lift ?? [0, 0, 0];
	const gain = params.gain ?? [1, 1, 1];
	const gamma = params.gamma ?? [1, 1, 1];
	if (!inRange(exposure, -5, 5)) throw new Error(`grade needs exposure -5..5, got ${exposure}`);
	if (!inRange(contrast, 0, 4)) throw new Error(`grade needs contrast 0..4, got ${contrast}`);
	if (!inRange(saturation, 0, 4)) throw new Error(`grade needs saturation 0..4, got ${saturation}`);
	if (!inRange(temperature, -1, 1)) throw new Error(`grade needs temperature -1..1, got ${temperature}`);
	if (!lift.every((v) => inRange(v, -1, 1))) throw new Error(`grade needs lift -1..1, got ${JSON.stringify(lift)}`);
	if (!gain.every((v) => inRange(v, 0, 4))) throw new Error(`grade needs gain 0..4, got ${JSON.stringify(gain)}`);
	if (!gamma.every((v) => inRange(v, 0.1, 4))) throw new Error(`grade needs gamma 0.1..4, got ${JSON.stringify(gamma)}`);
}

function scopeFrame(frame: SceneFrame): ScopesSample {
	const { data, width, height } = frame;
	const total = width * height;
	const lumaHist = new Array<number>(HIST_BINS).fill(0);
	const rgbHist: [number[], number[], number[]] = [
		new Array<number>(HIST_BINS).fill(0),
		new Array<number>(HIST_BINS).fill(0),
		new Array<number>(HIST_BINS).fill(0),
	];
	const waveform: Array<[number, number]> = Array.from({ length: WAVE_BANDS }, () => [255, 0] as [number, number]);
	let lumaSum = 0;
	let lumaSq = 0;
	let rSum = 0;
	let gSum = 0;
	let bSum = 0;
	let black = 0;
	let white = 0;
	for (let y = 0; y < height; y++) {
		const band = Math.min(WAVE_BANDS - 1, Math.floor((y * WAVE_BANDS) / height));
		for (let x = 0; x < width; x++) {
			const px = (y * width + x) * 3;
			const r = data[px]!;
			const g = data[px + 1]!;
			const b = data[px + 2]!;
			const luma = lumaOf(r, g, b);
			lumaSum += luma;
			lumaSq += luma * luma;
			rSum += r;
			gSum += g;
			bSum += b;
			if (luma <= BLACK_LEVEL) black++;
			if (luma >= WHITE_LEVEL) white++;
			lumaHist[Math.min(HIST_BINS - 1, Math.floor((luma * HIST_BINS) / 256))]!++;
			rgbHist[0]![Math.min(HIST_BINS - 1, (r * HIST_BINS) >> 8)]!++;
			rgbHist[1]![Math.min(HIST_BINS - 1, (g * HIST_BINS) >> 8)]!++;
			rgbHist[2]![Math.min(HIST_BINS - 1, (b * HIST_BINS) >> 8)]!++;
			const strip = waveform[band]!;
			if (luma < strip[0]) strip[0] = Math.round(luma);
			if (luma > strip[1]) strip[1] = Math.round(luma);
		}
	}
	const meanLuma = lumaSum / total;
	const lumaStd = Math.sqrt(Math.max(0, lumaSq / total - meanLuma * meanLuma));
	const channelMeans: [number, number, number] = [rSum / total, gSum / total, bSum / total];
	const mx = Math.max(...channelMeans);
	const mn = Math.min(...channelMeans);
	const mean = (rSum + gSum + bSum) / (3 * total);
	const castStrength = mx > 0 ? (mx - mn) / Math.max(1, mean) : 0;
	const castToward =
		castStrength < CAST_NONE ? 'none' : (['red', 'green', 'blue'] as const)[channelMeans.indexOf(mx)]!;
	return {
		time: frame.time,
		meanLuma,
		lumaStd,
		clippedBlack: black / total,
		clippedWhite: white / total,
		channelMeans,
		castToward,
		castStrength,
		lumaHist,
		rgbHist,
		waveform,
	};
}

/**
 * Scopes analysis for RGB frames in presentation order at one size:
 * per-frame scopes plus the clip verdict. See the header for what
 * the verdict does and does not claim.
 */
export function scopeClip(frames: ReadonlyArray<SceneFrame>): ScopesAnalysis {
	validateFrames(frames);
	const samples = frames.map(scopeFrame);
	const mean = (pick: (s: ScopesSample) => number) => samples.reduce((s, m) => s + pick(m), 0) / samples.length;
	const meanLuma = mean((s) => s.meanLuma);
	const meanClippedBlack = mean((s) => s.clippedBlack);
	const meanClippedWhite = mean((s) => s.clippedWhite);
	const meanCastStrength = mean((s) => s.castStrength);
	const meanStd = mean((s) => s.lumaStd);
	const verdict: ScopesVerdict =
		meanClippedWhite > CLIP_FRACTION
			? 'clipped-white'
			: meanClippedBlack > CLIP_FRACTION
				? 'clipped-black'
				: meanCastStrength > CAST_FRACTION
					? 'cast'
					: meanStd < FLAT_STD
						? 'flat'
						: 'balanced';
	return {
		samples,
		verdict,
		meanLuma,
		meanClippedBlack,
		meanClippedWhite,
		meanCastStrength,
		frames: samples.length,
		seconds: frames[frames.length - 1]!.time,
	};
}

/**
 * Applies a byte-space grade to one RGB frame: lift/gain/gamma, then
 * exposure, contrast around mid-gray, saturation around luma, then
 * the temperature red/blue seesaw. Returns a new frame; the input
 * is untouched.
 */
export function applyGrade(frame: SceneFrame, params: GradeParams): SceneFrame {
	validateFrames([frame]);
	validateGrade(params);
	const { exposure = 0, contrast = 1, saturation = 1, temperature = 0 } = params;
	const lift = params.lift ?? [0, 0, 0];
	const gain = params.gain ?? [1, 1, 1];
	const gamma = params.gamma ?? [1, 1, 1];
	const { data, width, height } = frame;
	const out = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i += 3) {
		let channels = [data[i]!, data[i + 1]!, data[i + 2]!];
		channels = channels.map((v, c) => 255 * Math.max(0, ((v + lift[c]! * 255) * gain[c]!) / 255) ** gamma[c]!);
		const stopped = 2 ** exposure;
		channels = channels.map((v) => v * stopped);
		channels = channels.map((v) => (v - 128) * contrast + 128);
		const luma = lumaOf(channels[0]!, channels[1]!, channels[2]!);
		channels = channels.map((v) => luma + (v - luma) * saturation);
		channels[0] = channels[0]! * (1 + 0.25 * temperature);
		channels[2] = channels[2]! * (1 - 0.25 * temperature);
		out[i] = clampByte(channels[0]!);
		out[i + 1] = clampByte(channels[1]!);
		out[i + 2] = clampByte(channels[2]!);
	}
	return { data: out, width, height, time: frame.time };
}
