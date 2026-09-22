/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Stereo pan laws: -1 is hard left, 0 center, +1 hard right. `equalPower`
// (the default, and what StereoPannerNode does) keeps perceived loudness
// constant across the field; `linear` crossfades amplitudes, which dips
// ~3 dB at center. Out-of-range pans clamp to the rails.

export type PanLaw = 'equalPower' | 'linear';

export interface StereoGains {
	left: number;
	right: number;
}

export function stereoGains(pan: number, law: PanLaw = 'equalPower'): StereoGains {
	const p = Math.min(1, Math.max(-1, Number.isFinite(pan) ? pan : 0));
	if (law === 'linear') return { left: (1 - p) / 2, right: (1 + p) / 2 };
	const angle = ((p + 1) * Math.PI) / 4;
	return { left: Math.cos(angle), right: Math.sin(angle) };
}
