/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Decibel/amplitude conversions shared by fades, pan, ducking, and meters.
// Amplitudes are linear multipliers (1 = unity); -Infinity dB is silence,
// and nothing here ever produces NaN: zeros clamp to silence.

/** Silence floor: amplitudes at or below this are -Infinity dB. */
export const SILENCE_FLOOR = 1e-12;

/** Linear amplitude multiplier to decibels (1 → 0, 0 → -Infinity). */
export function amplitudeToDb(amplitude: number): number {
	if (!(amplitude > SILENCE_FLOOR)) return -Infinity;
	return 20 * Math.log10(amplitude);
}

/** Decibels to a linear amplitude multiplier (0 → 1, -Infinity → 0). */
export function dbToAmplitude(db: number): number {
	if (db === -Infinity) return 0;
	if (!Number.isFinite(db)) return Number.NaN;
	return 10 ** (db / 20);
}

/** Power/energy ratio to decibels (mean squares compare with 10·log10). */
export function powerToDb(power: number): number {
	if (!(power > SILENCE_FLOOR * SILENCE_FLOOR)) return -Infinity;
	return 10 * Math.log10(power);
}

/** Clamp a dB value into a finite range, preserving -Infinity as silence. */
export function clampDb(db: number, min = -96, max = 24): number {
	if (db === -Infinity) return -Infinity;
	if (!Number.isFinite(db)) return max;
	return Math.min(max, Math.max(min, db));
}
