/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Clip fades: the gain multiplier (as dB to add) at a clip-local time,
// given head/tail fade lengths. `linear` ramps amplitude linearly (the
// honest default for short utility fades); `equalPower` follows a
// quarter-sine power curve, which reads as a steadier loudness sweep and
// crossfades without the midpoint dip. Times outside the clip clamp to
// silence rather than extrapolating.

import { amplitudeToDb } from './db';

export type FadeCurve = 'linear' | 'equalPower';

export interface FadeShape {
	/** Head fade length in seconds (0 = none). */
	in: number;
	/** Tail fade length in seconds (0 = none). */
	out: number;
	/** Clip length in seconds. */
	duration: number;
	curve?: FadeCurve;
}

function curveGain(progress: number, curve: FadeCurve): number {
	const t = Math.min(1, Math.max(0, progress));
	if (curve === 'equalPower') return Math.sin((t * Math.PI) / 2);
	return t;
}

/**
 * The fade gain at clip-local time `t` (seconds), as decibels to add to
 * the clip's volume: 0 through the body, ramping to -Infinity at both
 * edges under the fades. A fade longer than the clip meets in the middle;
 * both ends multiply (the quieter wins).
 */
export function fadeGainDbAt(t: number, shape: FadeShape): number {
	const curve = shape.curve ?? 'linear';
	const duration = Math.max(0, shape.duration);
	if (t < 0 || t > duration) return -Infinity;
	const fadeIn = Math.max(0, shape.in);
	const fadeOut = Math.max(0, shape.out);
	if (fadeIn <= 0 && fadeOut <= 0) return 0;

	let gain = 1;
	if (fadeIn > 0 && t < fadeIn) gain *= curveGain(t / fadeIn, curve);
	if (fadeOut > 0 && t > duration - fadeOut) gain *= curveGain((duration - t) / fadeOut, curve);
	return amplitudeToDb(gain);
}
