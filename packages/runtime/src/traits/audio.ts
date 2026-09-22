/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trait } from 'koota';

// Audio volume in decibels (0 dB = unity, -Infinity = silence).
export const Volume = trait({ value: 0 });

// Presence means muted.
export const Muted = trait();

// Runtime-only solo tag (not serialized).
export const Soloed = trait();

// Runtime-only: maps timeline time to AudioContext time while playing.
export const AudioPlayback = trait({
	wasPlaying: false,
	contextOffsetInSeconds: 0,
	timelineOffsetInSeconds: 0,
});

// Clip fades in seconds (linear amplitude ramps into the head / out of the
// tail). Presence opts the clip into the motion system's audio pass; both
// 0 fades nothing, and the trait is normally absent then.
export const Fade = trait({ in: 0, out: 0 });

// Stereo position, -1 (hard left) to +1 (hard right) under an equal-power
// law. Default 0 (center); keyframeable as the `pan` track.
export const Pan = trait({ value: 0 });

// Logical mix-bus assignment, e.g. 'dialogue', 'music', 'sfx' — the group
// ducking and future per-bus processing treat as one fader. 'master' (the
// default, when the trait is absent) ducks under nothing.
export const MixBus = trait({ value: 'master' });

// The timeline-frame window the clip's audio is audible in — the video span
// [start, end) when the trait is absent. A head reaching before the video
// starts is a J-cut, a tail outliving it an L-cut; the decoder plays source
// audio the trim would otherwise cut, where the file has it. A side of -1
// follows the video edge on that side (see getAudioWindow).
export const AudioRange = trait({ start: 0, end: 0 });
