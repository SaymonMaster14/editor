/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Loudness the way the meters mean it: K-weighted, gated BS.1770-4
// integrated loudness plus loudness range, and 4x-oversampled true peak.
// Chunk-fed, so the export measures the mix while it encodes and the
// `audio_loudness` tool measures a decoded file — same meter, same
// numbers. Silence measures -Infinity LUFS (nothing to be loud about);
// anything under one 400 ms block is unmeasurable and also -Infinity.
//
// Filter lineage: the K-weighting is the spec's pre-filter (high shelf,
// f0 1681.97 Hz) cascaded with the RLB high-pass (f0 38.14 Hz), with
// biquad coefficients derived per sample rate the way libebur128 and
// ffmpeg's ebur128 do it (bilinear transform of the analog prototype).
// Channel weights are 1.0 throughout: our mixes are mono/stereo, and the
// 1.41x surround weighting is not applied.

import { powerToDb } from './db';

export interface BiquadCoefficients {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

/**
 * The K-weighting biquads for a sample rate: [pre-filter shelf, RLB
 * high-pass]. y[n] = b0·x[n] + b1·x[n-1] + b2·x[n-2] − a1·y[n-1] − a2·y[n-2].
 */
export function kWeightingCoefficients(sampleRate: number): [BiquadCoefficients, BiquadCoefficients] {
	// Pre-filter shelf.
	const shelfF0 = 1681.974450955533;
	const shelfG = 3.986843036933593;
	const shelfQ = 0.7071752369554196;
	const shelfK = Math.tan((Math.PI * shelfF0) / sampleRate);
	const vh = 10 ** (shelfG / 20);
	const vb = vh ** 0.4996667741545416;
	const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
	const shelf: BiquadCoefficients = {
		b0: (vh + (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0,
		b1: (2 * (shelfK * shelfK - vh)) / shelfA0,
		b2: (vh - (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0,
		a1: (2 * (shelfK * shelfK - 1)) / shelfA0,
		a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0,
	};
	// RLB high-pass.
	const rlbF0 = 38.13547087602444;
	const rlbQ = 0.5003270373238773;
	const rlbK = Math.tan((Math.PI * rlbF0) / sampleRate);
	const norm = 1 / (1 + rlbK / rlbQ + rlbK * rlbK);
	const rlb: BiquadCoefficients = {
		b0: norm,
		b1: -2 * norm,
		b2: norm,
		a1: 2 * (rlbK * rlbK - 1) * norm,
		a2: (1 - rlbK / rlbQ + rlbK * rlbK) * norm,
	};
	return [shelf, rlb];
}

/** One biquad's streaming state (Direct Form II transposed). */
export interface BiquadState {
	s1: number;
	s2: number;
}

export function createBiquadState(): BiquadState {
	return { s1: 0, s2: 0 };
}

export function biquadStep(coef: BiquadCoefficients, state: BiquadState, x: number): number {
	const y = coef.b0 * x + state.s1;
	state.s1 = coef.b1 * x - coef.a1 * y + state.s2;
	state.s2 = coef.b2 * x - coef.a2 * y;
	return y;
}

/**
 * 4x oversampling for true peak: 4 phases × 96 taps, Hamming-windowed
 * sinc at π/4 (base-rate Nyquist). 384 taps keep the transition band
 * (~1.6 kHz wide) clear of 20 kHz content — shorter prototypes droop
 * audibly in the top octave and read low.
 */
const TRUE_PEAK_PHASES = 4;
const TRUE_PEAK_TAPS_PER_PHASE = 96;
const TRUE_PEAK_TAPS = TRUE_PEAK_PHASES * TRUE_PEAK_TAPS_PER_PHASE;

function truePeakPrototype(): Float64Array {
	const delay = (TRUE_PEAK_TAPS - 1) / 2;
	const cutoff = Math.PI / TRUE_PEAK_PHASES;
	const taps = new Float64Array(TRUE_PEAK_TAPS);
	let sum = 0;
	for (let i = 0; i < TRUE_PEAK_TAPS; i++) {
		const t = i - delay;
		const sinc = Math.abs(t) < 1e-9 ? cutoff / Math.PI : Math.sin(cutoff * t) / (Math.PI * t);
		const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TRUE_PEAK_TAPS - 1));
		taps[i] = sinc * hamming;
		sum += taps[i]!;
	}
	for (let i = 0; i < TRUE_PEAK_TAPS; i++) taps[i]! /= sum;
	return taps;
}

const TRUE_PEAK_TAPS_PROTO = truePeakPrototype();

export interface LoudnessResult {
	/** Gated integrated loudness; -Infinity when unmeasurable (silence, or under one 400 ms block). */
	integratedLUFS: number;
	/** 10th–95th percentile spread of 3 s short-term loudness; null when fewer than two gated windows exist. */
	loudnessRangeLU: number | null;
	/** 4x-oversampled true peak, dBTP. */
	truePeakDbTP: number;
	/** Sample peak, dBFS. */
	samplePeakDbFS: number;
	seconds: number;
	gatedBlockCount: number;
	totalBlockCount: number;
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = 10;
const LRA_RELATIVE_GATE_LU = 20;
const LRA_WINDOW_SECONDS = 3;

/**
 * A streaming BS.1770 meter. Feed it planar channel data in any chunking;
 * chunk boundaries never move the result. One instance measures one
 * program (a mix, a file); for another program, make another meter.
 */
export class LoudnessMeter {
	private readonly sampleRate: number;
	private readonly channels: number;
	private readonly shelf: BiquadCoefficients;
	private readonly rlb: BiquadCoefficients;
	/** Per-channel filter memories [shelf, rlb]. */
	private readonly states: Array<[BiquadState, BiquadState]>;
	/** 100 ms granule length in samples; blocks are 4 granules. */
	private readonly granuleSamples: number;
	/** Energy sums of finished 100 ms granules (all channels, K-weighted). */
	private readonly granuleEnergies: number[] = [];
	private granuleFrames = 0;
	private granuleEnergy = 0;
	/** Per-channel true-peak histories (base-rate samples each). */
	private readonly peakHistories: Float64Array[];
	/** Consecutive upsampled magnitudes (per channel) for parabolic peak refinement. */
	private readonly peakPrev: Array<[number, number]>;
	private truePeak = 0;
	private samplePeak = 0;
	private frames = 0;

	public constructor(sampleRate: number, channels: number) {
		if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error(`loudness: bad sample rate ${sampleRate}`);
		if (!Number.isInteger(channels) || channels < 1) throw new Error(`loudness: bad channel count ${channels}`);
		this.sampleRate = sampleRate;
		this.channels = channels;
		[this.shelf, this.rlb] = kWeightingCoefficients(sampleRate);
		this.states = Array.from({ length: channels }, () => [createBiquadState(), createBiquadState()] as [BiquadState, BiquadState]);
		this.granuleSamples = Math.max(1, Math.round(sampleRate / 10));
		this.peakHistories = Array.from({ length: channels }, () => new Float64Array(TRUE_PEAK_TAPS_PER_PHASE));
		this.peakPrev = Array.from({ length: channels }, () => [0, 0] as [number, number]);
	}

	/** Feed planar channel data: `channels[c][offset + i]`, `frames` samples each. */
	public push(channels: ReadonlyArray<ArrayLike<number>>, offset: number, frames: number): void {
		if (channels.length !== this.channels) {
			throw new Error(`loudness: got ${channels.length} channels, meter has ${this.channels}`);
		}
		for (let i = 0; i < frames; i++) {
			const at = offset + i;
			for (let c = 0; c < this.channels; c++) {
				const sample = channels[c]![at]!;
				const abs = Math.abs(sample);
				if (abs > this.samplePeak) this.samplePeak = abs;
				// K-weighting into the granule energy.
				const [shelfState, rlbState] = this.states[c]!;
				const weighted = biquadStep(this.rlb, rlbState, biquadStep(this.shelf, shelfState, sample));
				this.granuleEnergy += weighted * weighted;
				// 4-phase true peak over the trailing window.
				const history = this.peakHistories[c]!;
				history.copyWithin(0, 1);
				history[TRUE_PEAK_TAPS_PER_PHASE - 1] = sample;
				// Polyphase decomposition: upsampled output 4n+p is the sum
				// over h[p+4k]·x[n−k] — newest sample on the lowest tap.
				// Phases stream in time order, so consecutive outputs refine
				// local maxima parabolically: 4x alone can sit a quarter grid
				// step off a crest (up to ~0.17 dB cold at fs/4).
				const prev = this.peakPrev[c]!;
				for (let phase = 0; phase < TRUE_PEAK_PHASES; phase++) {
					let y = 0;
					for (let tap = 0; tap < TRUE_PEAK_TAPS_PER_PHASE; tap++) {
						y += TRUE_PEAK_TAPS_PROTO[phase + TRUE_PEAK_PHASES * tap]! * history[TRUE_PEAK_TAPS_PER_PHASE - 1 - tap]!;
					}
					const peak = Math.abs(TRUE_PEAK_PHASES * y);
					if (peak > this.truePeak) this.truePeak = peak;
					const [y0, y1] = prev;
					if (y1 >= y0 && y1 >= peak && y1 > 0) {
						const d = y0 - 2 * y1 + peak;
						if (d < -1e-9 * y1) {
							const refined = y1 - ((y0 - peak) * (y0 - peak)) / (8 * d);
							if (refined > this.truePeak) this.truePeak = refined;
						}
					}
					prev[0] = y1;
					prev[1] = peak;
				}
			}
			this.frames++;
			this.granuleFrames++;
			if (this.granuleFrames >= this.granuleSamples) {
				// BS.1770 sums channel energies (dual mono reads +3.01 LU
				// over mono); only the time axis is averaged.
				this.granuleEnergies.push(this.granuleEnergy / this.granuleFrames);
				this.granuleFrames = 0;
				this.granuleEnergy = 0;
			}
		}
	}

	public result(): LoudnessResult {
		// 400 ms blocks on a 100 ms hop: mean of 4 granule energies each.
		const blockEnergies: number[] = [];
		for (let start = 0; start + 4 <= this.granuleEnergies.length; start++) {
			blockEnergies.push(
				(this.granuleEnergies[start]! + this.granuleEnergies[start + 1]! + this.granuleEnergies[start + 2]! + this.granuleEnergies[start + 3]!) / 4,
			);
		}
		const blockLoudness = blockEnergies.map((energy) => -0.691 + powerToDb(energy));
		const aboveAbsolute = blockLoudness.filter((lufs) => lufs >= ABSOLUTE_GATE_LUFS);
		let integratedLUFS = -Infinity;
		let gatedBlockCount = 0;
		if (aboveAbsolute.length > 0) {
			// Both gates apply to energy: the relative threshold sits 10 LU
			// below the absolute-gated integrated loudness (mean energy,
			// not mean of LUFS — those are not the same).
			let absoluteEnergy = 0;
			for (let i = 0; i < blockLoudness.length; i++) {
				if (blockLoudness[i]! >= ABSOLUTE_GATE_LUFS) absoluteEnergy += blockEnergies[i]!;
			}
			const threshold = -0.691 + powerToDb(absoluteEnergy / aboveAbsolute.length) - RELATIVE_GATE_LU;
			let energySum = 0;
			for (let i = 0; i < blockLoudness.length; i++) {
				if (blockLoudness[i]! >= ABSOLUTE_GATE_LUFS && blockLoudness[i]! >= threshold) {
					energySum += blockEnergies[i]!;
					gatedBlockCount++;
				}
			}
			if (gatedBlockCount > 0) integratedLUFS = -0.691 + powerToDb(energySum / gatedBlockCount);
		}

		// LRA: 3 s short-term windows on the same 100 ms hop.
		let loudnessRangeLU: number | null = null;
		const windowGranules = Math.round(LRA_WINDOW_SECONDS * 10);
		if (this.granuleEnergies.length >= windowGranules) {
			const shortTerm: number[] = [];
			for (let start = 0; start + windowGranules <= this.granuleEnergies.length; start++) {
				let sum = 0;
				for (let i = 0; i < windowGranules; i++) sum += this.granuleEnergies[start + i]!;
				shortTerm.push(-0.691 + powerToDb(sum / windowGranules));
			}
			const gated = shortTerm.filter((lufs) => lufs >= ABSOLUTE_GATE_LUFS && lufs >= integratedLUFS - LRA_RELATIVE_GATE_LU);
			if (gated.length >= 2) {
				gated.sort((a, b) => a - b);
				const at = (p: number): number => {
					const pos = (p / 100) * (gated.length - 1);
					const lo = Math.floor(pos);
					const hi = Math.ceil(pos);
					return gated[lo]! + (gated[hi]! - gated[lo]!) * (pos - lo);
				};
				loudnessRangeLU = Math.max(0, at(95) - at(10));
			}
		}

		return {
			integratedLUFS,
			loudnessRangeLU,
			truePeakDbTP: this.truePeak <= 0 ? -Infinity : 20 * Math.log10(this.truePeak),
			samplePeakDbFS: this.samplePeak <= 0 ? -Infinity : 20 * Math.log10(this.samplePeak),
			seconds: this.frames / this.sampleRate,
			gatedBlockCount,
			totalBlockCount: blockEnergies.length,
		};
	}
}

/** Measure whole planar buffers in one call. */
export function measureLoudness(channels: ReadonlyArray<ArrayLike<number>>, sampleRate: number): LoudnessResult {
	const frames = channels.length ? channels[0]!.length : 0;
	const meter = new LoudnessMeter(sampleRate, channels.length || 1);
	if (channels.length) meter.push(channels, 0, frames);
	return meter.result();
}
