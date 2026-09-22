/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Analysis-driven ducking: the gain curve a ducked bus (music, ambience)
// follows, computed from the key bus (dialogue) envelope rather than a
// live follower — so realtime playback and offline export schedule the
// same curve and sound the same. Gate-style: whenever the key sits above
// `thresholdDb` the ducked bus heads for `depthDb`, with attack/release
// ballistics and an optional hold; below threshold it recovers to unity.
// The envelope comes from the key bus's placed peaks (see the runtime's
// ducking planner); this module only turns levels into gain.

export interface DuckingSettings {
	/** Key level that trips the duck, dBFS-ish (peaks-derived). */
	thresholdDb: number;
	/** Ducked depth, a negative dB value (e.g. -8). */
	depthDb: number;
	/** Time to reach ~63% of depth after the key trips, ms. */
	attackMs: number;
	/** Time to recover ~63% toward unity after the key drops, ms. */
	releaseMs: number;
	/** Hold full depth this long after the key drops before releasing, ms. */
	holdMs?: number;
}

export interface EnvelopePoint {
	time: number;
	/** Key bus level, dB (peaks-derived, ≤ 0-ish). */
	levelDb: number;
}

export interface GainPoint {
	time: number;
	/** Gain to apply to the ducked bus, dB (≤ 0). */
	gainDb: number;
}

/**
 * Turns a key envelope into a ducking gain curve. Points stay on the
 * envelope's own times (the scheduler ramps between them); an empty
 * envelope ducks nothing. Times must be non-decreasing.
 */
export function duckingCurve(envelope: readonly EnvelopePoint[], settings: DuckingSettings): GainPoint[] {
	const depth = Math.min(0, settings.depthDb);
	const attack = Math.max(1, settings.attackMs) / 1000;
	const release = Math.max(1, settings.releaseMs) / 1000;
	const hold = Math.max(0, settings.holdMs ?? 0) / 1000;
	if (!envelope.length) return [{ time: 0, gainDb: 0 }];

	const curve: GainPoint[] = [];
	let reduction = 0; // current duck depth, positive dB
	let holdUntil = -Infinity;
	let lastTime = envelope[0]!.time;
	curve.push({ time: lastTime, gainDb: 0 });

	for (const point of envelope) {
		const dt = Math.max(0, point.time - lastTime);
		lastTime = point.time;
		const tripped = point.levelDb > settings.thresholdDb;
		if (tripped) holdUntil = point.time + hold;
		const target = tripped || point.time < holdUntil ? -depth : 0;
		const tau = target > reduction ? attack : release;
		const coef = 1 - Math.exp(-dt / tau);
		reduction += (target - reduction) * coef;
		if (Math.abs(reduction) < 1e-6) reduction = 0;
		if (Math.abs(reduction - target) < 1e-9) reduction = target;
		const gain = -reduction;
		curve.push({ time: point.time, gainDb: gain === 0 ? 0 : gain });
	}
	return curve;
}
