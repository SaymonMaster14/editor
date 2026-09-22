/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SceneFrame } from '@diffusionstudio/scene';

// Temporal processing, tiers 1: time maps plus nearest/blend sampling.
// A retime is a source-to-output time function built from one base
// speed, an optional piecewise-linear speed ramp over SOURCE seconds,
// optional freeze holds (output time passes while source stands
// still), and an optional reverse, which runs that whole map
// backwards so ramp and freeze keys stay attached to source times.
// Output frames
// are laid at the output fps and each is inverted to its source time
// by bisection; the sampler then resolves every entry to RGB by
// nearest frame or a linear blend of the bracketing pair. Blending
// smooths slow motion honestly: it cross-dissolves, it does not
// morph — true motion-interpolated frames need optical flow, which
// this tier deliberately does not claim (see the Flow field: none).
//
// Honest limits: no optical flow, so slow motion past ~0.5x strobes
// on fast movement and blends ghost instead; freeze holds repeat one
// decoded frame, they do not synthesize grain or motion; ramp keys
// outside the source clamp to the nearest key speed rather than
// erroring, and are reported back so callers see the clamping.

export interface RampKey {
	/** Source time in seconds. */
	time: number;
	/** Playback speed from here: 1 normal, 0.5 half, 2 double. */
	speed: number;
}

export interface FreezeHold {
	/** Source time to hold, seconds. */
	at: number;
	/** Output seconds the hold lasts. */
	hold: number;
}

export interface RetimeOptions {
	/** Base speed multiplier. Default 1. */
	speed?: number;
	/** Play the source backwards. Default false. */
	reverse?: boolean;
	/** Freeze holds in source seconds. Default []. */
	freeze?: FreezeHold[];
	/** Speed ramp keys in source seconds. Default flat 1x. */
	ramp?: RampKey[];
	/** Blend bracketing frames instead of nearest. Default false. */
	blend?: boolean;
}

export interface TimeMapEntry {
	/** Output time in seconds. */
	time: number;
	/** Source time this output frame shows, seconds. */
	src: number;
}

export interface Retime {
	/** One entry per output frame, ascending in output time. */
	map: TimeMapEntry[];
	outFrames: number;
	outSeconds: number;
	srcFrames: number;
	srcSeconds: number;
}

const EPSILON = 1e-9;

function validateFrames(frames: ReadonlyArray<SceneFrame>): void {
	if (!frames.length) throw new Error('retime needs at least one frame');
	for (const frame of frames) {
		if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
			throw new Error(`retime needs positive integer dimensions, got ${frame.width}x${frame.height}`);
		}
		if (frame.data.length !== frame.width * frame.height * 3) {
			throw new Error(`retime needs width*height*3 bytes, got ${frame.data.length} for ${frame.width}x${frame.height}`);
		}
	}
	const { width, height } = frames[0]!;
	if (!frames.every((f) => f.width === width && f.height === height)) {
		throw new Error('retime needs every frame at one size');
	}
	for (let i = 1; i < frames.length; i++) {
		if (!(frames[i]!.time > frames[i - 1]!.time)) throw new Error('retime needs strictly ascending frame times');
	}
}

function validateOptions(options: RetimeOptions, srcEnd: number): { speed: number; ramp: RampKey[]; freeze: FreezeHold[] } {
	const speed = options.speed ?? 1;
	if (!(speed > 0 && Number.isFinite(speed))) throw new Error(`retime needs a positive finite speed, got ${speed}`);
	const ramp = [...(options.ramp ?? [])];
	for (const key of ramp) {
		if (!Number.isFinite(key.time) || !(key.speed > 0 && Number.isFinite(key.speed))) {
			throw new Error(`retime needs finite ramp keys with positive speed, got ${JSON.stringify(key)}`);
		}
	}
	for (let i = 1; i < ramp.length; i++) {
		if (!(ramp[i]!.time > ramp[i - 1]!.time)) throw new Error('retime needs strictly ascending ramp times');
	}
	const freeze = [...(options.freeze ?? [])];
	for (const hold of freeze) {
		if (!Number.isFinite(hold.at) || !(hold.hold >= 0 && Number.isFinite(hold.hold))) {
			throw new Error(`retime needs finite freeze holds, got ${JSON.stringify(hold)}`);
		}
		if (hold.at < 0 || hold.at > srcEnd) {
			throw new Error(`retime freeze at ${hold.at}s sits outside the 0-${srcEnd}s source`);
		}
	}
	return { speed, ramp, freeze };
}

/** Effective speed at source time t: base times the ramp (clamped past its keys). */
function speedAt(t: number, base: number, ramp: RampKey[]): number {
	let scale = 1;
	if (ramp.length) {
		if (t <= ramp[0]!.time) scale = ramp[0]!.speed;
		else if (t >= ramp[ramp.length - 1]!.time) scale = ramp[ramp.length - 1]!.speed;
		else {
			for (let i = 1; i < ramp.length; i++) {
				const prev = ramp[i - 1]!;
				const next = ramp[i]!;
				if (t <= next.time) {
					const f = (t - prev.time) / (next.time - prev.time);
					scale = prev.speed + f * (next.speed - prev.speed);
					break;
				}
			}
		}
	}
	return base * scale;
}

/**
 * Output time for source time s: the integral of 1/speed plus every
 * freeze hold at or before s. Piecewise-closed-form over the ramp
 * knots: constant-speed spans integrate linearly, linear ramps
 * integrate logarithmically. Monotone non-decreasing in s.
 */
function outTimeAt(s: number, base: number, ramp: RampKey[], freeze: FreezeHold[]): number {
	const knots = [0, ...ramp.map((k) => k.time)];
	let out = 0;
	for (let i = 0; i < knots.length; i++) {
		const a = Math.max(0, knots[i]!);
		const b = Math.min(s, i + 1 < knots.length ? knots[i + 1]! : s);
		if (b <= a) continue;
		const v0 = speedAt(a, base, ramp);
		const v1 = speedAt(b, base, ramp);
		out += Math.abs(v1 - v0) < 1e-12 ? (b - a) / v0 : ((b - a) * (Math.log(v1) - Math.log(v0))) / (v1 - v0);
	}
	for (const hold of freeze) {
		if (hold.at <= s) out += hold.hold;
	}
	return out;
}

/** Smallest source time whose output reaches T (bisection; freezes map their whole hold to `at`). */
function srcTimeAt(target: number, srcEnd: number, base: number, ramp: RampKey[], freeze: FreezeHold[]): number {
	let lo = 0;
	let hi = srcEnd;
	for (let i = 0; i < 64; i++) {
		const mid = (lo + hi) / 2;
		if (outTimeAt(mid, base, ramp, freeze) < target) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/**
 * Time map retiming source frames (presentation order, one size) to
 * `outFps` under `options`. Ramp and freeze keys always name source
 * times; reversal plays the resulting map backwards.
 */
export function retime(frames: ReadonlyArray<SceneFrame>, outFps: number, options: RetimeOptions = {}): Retime {
	validateFrames(frames);
	if (!(outFps > 0 && Number.isFinite(outFps))) throw new Error(`retime needs a positive finite fps, got ${outFps}`);
	const srcEnd = frames[frames.length - 1]!.time;
	const { speed, ramp, freeze } = validateOptions(options, srcEnd);
	const reverse = options.reverse ?? false;

	const duration = outTimeAt(srcEnd, speed, ramp, freeze);
	const outFrames = Math.max(1, Math.floor(duration * outFps + EPSILON) + 1);
	const map: TimeMapEntry[] = [];
	for (let k = 0; k < outFrames; k++) {
		const time = Math.min(k / outFps, duration);
		// Reversal runs the forward map backwards: out t shows the
		// source that forward playback shows at D - t, so ramp and
		// freeze keys stay attached to their source times.
		const warped = reverse ? duration - time : time;
		const src = srcTimeAt(Math.min(Math.max(warped, 0), duration), srcEnd, speed, ramp, freeze);
		map.push({ time, src });
	}
	return { map, outFrames, outSeconds: duration, srcFrames: frames.length, srcSeconds: srcEnd };
}

/** Index of the last frame at or before t (clamped into range). */
function bracket(frames: ReadonlyArray<SceneFrame>, t: number): number {
	let lo = 0;
	let hi = frames.length - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (frames[mid]!.time <= t) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * Resolves a retime map to RGB frames: nearest source frame per entry,
 * or a linear blend of the bracketing pair when options.blend is set.
 * Times come from the map; sizes come from the source.
 */
export function sampleFrames(
	frames: ReadonlyArray<SceneFrame>,
	map: ReadonlyArray<TimeMapEntry>,
	options: RetimeOptions = {},
): SceneFrame[] {
	validateFrames(frames);
	const { width, height } = frames[0]!;
	const blend = options.blend ?? false;
	return map.map((entry) => {
		const i = bracket(frames, entry.src);
		const lo = frames[i]!;
		const hi = frames[Math.min(i + 1, frames.length - 1)]!;
		if (!blend || hi === lo || hi.time <= lo.time || entry.src <= lo.time || entry.src >= hi.time) {
			const nearer = entry.src - lo.time <= hi.time - entry.src ? lo : hi;
			return { data: nearer.data.slice(), width, height, time: entry.time };
		}
		const f = (entry.src - lo.time) / (hi.time - lo.time);
		const data = new Uint8Array(lo.data.length);
		for (let k = 0; k < data.length; k++) data[k] = Math.round(lo.data[k]! * (1 - f) + hi.data[k]! * f);
		return { data, width, height, time: entry.time };
	});
}
