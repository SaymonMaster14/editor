/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Beat tracking on decoded PCM: where the onsets are, what tempo they
// imply, and the beat grid itself. Spectral flux over a short-time
// Fourier transform finds the attacks, autocorrelation of the onset
// envelope finds the period (weighted toward musical tempi the way
// Ellis's tracker is), and dynamic programming lays beats that favor
// strong onsets at a steady spacing. Pure TypeScript, no model, fast
// enough to run on whole files in the renderer.
//
// Honest limits: this is a percussive front-end. Clicks, drums, and
// plucky attacks track well; legato strings with no attacks have no
// grid to find (confidence says so). Downbeats are not detected —
// meter needs harmonic context this front-end does not have.

export interface BeatGrid {
	/** Estimated tempo in BPM, or 0 when no grid was found. */
	bpm: number;
	/** Beat times in seconds, ascending, spanning the analyzed audio. */
	beats: number[];
	/** Detected onset times in seconds, ascending. */
	onsets: number[];
	/** Mean onset strength at beats over mean onset strength (0–1+). */
	confidence: number;
	/** Length of the analyzed audio in seconds. */
	durationSeconds: number;
}

export interface BeatTrackOptions {
	/** Slowest tempo to consider. Default 60. */
	minBpm?: number;
	/** Fastest tempo to consider. Default 200. */
	maxBpm?: number;
}

const FRAME_SIZE = 1024;
const HOP_SIZE = 512;

const EMPTY_GRID = (durationSeconds: number): BeatGrid => ({
	bpm: 0,
	beats: [],
	onsets: [],
	confidence: 0,
	durationSeconds,
});

/**
 * The beat grid of decoded audio. `channels` is one Float32Array per
 * channel (as `measureLoudness` takes); channels are averaged to mono
 * before analysis. Silence, sustained tones, and sub-second clips
 * return an empty grid (bpm 0) rather than a hallucinated tempo.
 */
export function trackBeats(
	channels: ReadonlyArray<Float32Array>,
	sampleRate: number,
	options: BeatTrackOptions = {},
): BeatGrid {
	if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new Error('trackBeats needs at least one channel and a positive sample rate');
	}
	const frames = Math.max(...channels.map((channel) => channel.length));
	const durationSeconds = frames / sampleRate;
	const minBpm = options.minBpm ?? 60;
	const maxBpm = options.maxBpm ?? 200;
	if (frames < FRAME_SIZE * 2 || minBpm <= 0 || maxBpm <= minBpm) return EMPTY_GRID(durationSeconds);

	const envelope = onsetEnvelope(mixMono(channels, frames), sampleRate);
	const fps = sampleRate / HOP_SIZE;
	if (envelope.length < 8) return EMPTY_GRID(durationSeconds);

	const onsets = pickOnsets(envelope, fps);
	// Fewer than three attacks carry no tempo: keep the onsets, skip the grid.
	if (onsets.length < 3) return { ...EMPTY_GRID(durationSeconds), onsets };
	const period = estimatePeriod(envelope, fps, minBpm, maxBpm);
	if (!period) return { ...EMPTY_GRID(durationSeconds), onsets };

	const beats = trackBeatPhase(envelope, fps, period);
	const bpm = (60 * fps) / period;
	return {
		bpm,
		beats,
		onsets,
		confidence: beatConfidence(envelope, fps, beats),
		durationSeconds,
	};
}

/** Average of the channels, zero-padded to `frames`. */
function mixMono(channels: ReadonlyArray<Float32Array>, frames: number): Float32Array {
	const mono = new Float32Array(frames);
	for (const channel of channels) {
		for (let i = 0; i < channel.length; i++) mono[i]! += channel[i]!;
	}
	const gain = 1 / channels.length;
	for (let i = 0; i < frames; i++) mono[i]! *= gain;
	return mono;
}

/**
 * Log-magnitude spectral flux per hop: how much new spectral energy
 * each frame adds over the last. Attacks read as sharp positive
 * excursions; decays and steady state read near zero.
 */
function onsetEnvelope(mono: Float32Array, sampleRate: number): Float32Array {
	// Centered windows: hop i spans [i·H − W/2, i·H + W/2), zero-padded
	// past the edges, so an attack at sample 0 lands at full window
	// weight instead of under the Hann taper (where quantization noise
	// decides whether it exists). Follows librosa's centering convention.
	const pad = FRAME_SIZE / 2;
	const padded = new Float32Array(mono.length + FRAME_SIZE);
	padded.set(mono, pad);
	const hopCount = 1 + Math.floor((mono.length - 1) / HOP_SIZE);
	const envelope = new Float32Array(Math.max(0, hopCount));
	const window = hannWindow(FRAME_SIZE);
	const real = new Float32Array(FRAME_SIZE);
	const imag = new Float32Array(FRAME_SIZE);
	const floor = 1e-6 / sampleRate;
	// Silence before the start: hop 0 measures rises against the same
	// floor every other hop does, so a downbeat at sample 0 reads at
	// full weight instead of against a zero reference.
	const prev = new Float32Array(FRAME_SIZE / 2 + 1).fill(Math.log(floor));

	for (let hop = 0; hop < hopCount; hop++) {
		const offset = hop * HOP_SIZE;
		for (let i = 0; i < FRAME_SIZE; i++) {
			real[i] = padded[offset + i]! * window[i]!;
			imag[i] = 0;
		}
		fft(real, imag);
		let flux = 0;
		for (let k = 0; k <= FRAME_SIZE / 2; k++) {
			const mag = Math.sqrt(real[k]! * real[k]! + imag[k]! * imag[k]!);
			const db = Math.log(mag + floor);
			const rise = db - prev[k]!;
			if (rise > 0) flux += rise;
			prev[k] = db;
		}
		envelope[hop] = flux;
	}

	let peak = 0;
	for (const value of envelope) peak = Math.max(peak, value);
	// Below this the "flux" is floating-point dust, not attacks: silence
	// must read as no onsets at all rather than a normalized noise floor.
	if (peak < 1e-3) return new Float32Array(envelope.length);
	for (let i = 0; i < envelope.length; i++) envelope[i]! /= peak;
	return envelope;
}

function hannWindow(size: number): Float32Array {
	const window = new Float32Array(size);
	for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
	return window;
}

/** In-place radix-2 decimation-in-time FFT, forward, no scaling. */
export function fft(real: Float32Array, imag: Float32Array): void {
	const n = real.length;
	if (n !== imag.length || n < 2 || (n & (n - 1)) !== 0) {
		throw new Error('fft needs two equal power-of-two buffers');
	}
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			const tr = real[i]!;
			real[i] = real[j]!;
			real[j] = tr;
			const ti = imag[i]!;
			imag[i] = imag[j]!;
			imag[j] = ti;
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const angle = (-2 * Math.PI) / len;
		const wr = Math.cos(angle);
		const wi = Math.sin(angle);
		for (let i = 0; i < n; i += len) {
			let cr = 1;
			let ci = 0;
			for (let j = 0; j < len / 2; j++) {
				const ur = real[i + j]!;
				const ui = imag[i + j]!;
				const vr = real[i + j + len / 2]! * cr - imag[i + j + len / 2]! * ci;
				const vi = real[i + j + len / 2]! * ci + imag[i + j + len / 2]! * cr;
				real[i + j] = ur + vr;
				imag[i + j] = ui + vi;
				real[i + j + len / 2] = ur - vr;
				imag[i + j + len / 2] = ui - vi;
				const nr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = nr;
			}
		}
	}
}

/**
 * Onset frames: local maxima that clear an adaptive floor (a fraction
 * of the global peak plus the local mean), at least ~50 ms apart.
 */
function pickOnsets(envelope: Float32Array, fps: number): number[] {
	const radius = 3;
	const minGap = Math.max(1, Math.round(0.05 * fps));
	let floor = 0;
	for (const value of envelope) floor = Math.max(floor, value);
	floor *= 0.12;
	const onsets: number[] = [];
	let last = -minGap;
	for (let i = 0; i < envelope.length; i++) {
		if (i - last < minGap) continue;
		const value = envelope[i]!;
		if (value <= floor) continue;
		let isMax = true;
		let localSum = 0;
		let localCount = 0;
		for (let j = -radius; j <= radius; j++) {
			const k = i + j;
			if (k < 0 || k >= envelope.length || j === 0) continue;
			localSum += envelope[k]!;
			localCount++;
			if (envelope[k]! > value) {
				isMax = false;
				break;
			}
		}
		if (isMax && value >= localSum / Math.max(1, localCount) + floor * 0.5) {
			onsets.push(i / fps);
			last = i;
		}
	}
	return onsets;
}

/**
 * The beat period in envelope frames: the autocorrelation lag with
 * the best perceptually weighted score over the tempo range,
 * parabolically refined. Null when the envelope carries no pulse.
 */
function estimatePeriod(envelope: Float32Array, fps: number, minBpm: number, maxBpm: number): number | null {
	const minLag = Math.max(4, Math.round((60 * fps) / maxBpm));
	const maxLag = Math.min(envelope.length - 2, Math.round((60 * fps) / minBpm));
	if (maxLag <= minLag) return null;

	const scores = new Float32Array(maxLag + 2);
	for (let lag = minLag; lag <= maxLag; lag++) {
		let sum = 0;
		for (let i = 0; i + lag < envelope.length; i++) sum += envelope[i]! * envelope[i + lag]!;
		const bpm = (60 * fps) / lag;
		// Favor musical tempi: a log-Gaussian around 120 BPM, sigma one octave.
		const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2);
		scores[lag] = (sum / (envelope.length - lag)) * weight;
	}
	let best = minLag;
	let mean = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		if (scores[lag]! > scores[best]!) best = lag;
		mean += scores[lag]!;
	}
	mean /= maxLag - minLag + 1;
	// A genuine pulse correlates far above its surroundings; wash and
	// beating correlate broadly, so a peak without margin is no tempo.
	if (scores[best]! <= 0 || scores[best]! < 2 * mean) return null;
	// Parabolic refinement around the peak for sub-frame periods.
	const prev = scores[best - 1] ?? scores[best]!;
	const next = scores[best + 1] ?? scores[best]!;
	const denom = prev - 2 * scores[best]! + next;
	const shift = denom !== 0 ? (0.5 * (prev - next)) / denom : 0;
	return best + Math.max(-1, Math.min(1, shift));
}

/**
 * Beat frames by dynamic programming: walk the envelope collecting
 * onset strength, paying a log-Gaussian penalty for steps away from
 * the period, then backtrack from the best-scoring recent frame.
 */
function trackBeatPhase(envelope: Float32Array, fps: number, period: number): number[] {
	const n = envelope.length;
	const best = new Float64Array(n).fill(-Infinity);
	const from = new Int32Array(n).fill(-1);
	const minStep = Math.max(1, Math.floor(period / 2));
	const maxStep = Math.ceil(period * 2);

	for (let i = 0; i < n; i++) {
		let score = envelope[i]!;
		let prev = -1;
		for (let step = minStep; step <= maxStep; step++) {
			const j = i - step;
			if (j < 0) continue;
			if (best[j] === -Infinity) continue;
			const penalty = -0.5 * (Math.log2(step / period) / 0.35) ** 2;
			const candidate = best[j]! + envelope[i]! + penalty;
			if (candidate > score) {
				score = candidate;
				prev = j;
			}
		}
		// Starting a chain here is always allowed (score above).
		best[i] = score;
		from[i] = prev;
	}

	let end = n - 1;
	for (let i = n - 1; i >= Math.max(0, n - 1 - Math.ceil(period)); i--) {
		if (best[i]! > best[end]!) end = i;
	}
	const frames: number[] = [];
	for (let i = end; i >= 0; i = from[i]!) {
		frames.push(i);
		if (from[i] === -1) break;
	}
	frames.reverse();
	return frames.map((frame) => frame / fps);
}

/**
 * Mean onset strength at beat frames over mean onset strength: ~1
 * means beats land on average energy (no grid), well above 1 means
 * they land on the attacks.
 */
function beatConfidence(envelope: Float32Array, fps: number, beats: number[]): number {
	if (!beats.length) return 0;
	let total = 0;
	for (const value of envelope) total += value;
	const mean = total / envelope.length;
	if (mean <= 0) return 0;
	let atBeats = 0;
	for (const beat of beats) {
		const frame = Math.round(beat * fps);
		if (frame >= 0 && frame < envelope.length) atBeats += envelope[frame]!;
	}
	return atBeats / beats.length / mean;
}

/** The beat at or before `time` (index and time), or null before the first. */
export function prevBeat(beats: ReadonlyArray<number>, time: number): { index: number; time: number } | null {
	let found: { index: number; time: number } | null = null;
	for (let i = 0; i < beats.length; i++) {
		if (beats[i]! <= time) found = { index: i, time: beats[i]! };
		else break;
	}
	return found;
}

/** The beat at or after `time` (index and time), or null past the last. */
export function nextBeat(beats: ReadonlyArray<number>, time: number): { index: number; time: number } | null {
	for (let i = 0; i < beats.length; i++) {
		if (beats[i]! >= time) return { index: i, time: beats[i]! };
	}
	return null;
}

/** The beat closest to `time` (index and time), or null with no beats. */
export function nearestBeat(beats: ReadonlyArray<number>, time: number): { index: number; time: number } | null {
	const prev = prevBeat(beats, time);
	const next = nextBeat(beats, time);
	if (!prev) return next;
	if (!next) return prev;
	return time - prev.time <= next.time - time ? prev : next;
}
