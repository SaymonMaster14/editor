/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Audio corrections as edits. Gain, fades, pan and mute are props of the
 * node's element (`volume` in dB, `fadeIn`/`fadeOut` in seconds, `pan` from
 * -1 to 1, `muted`), each unset at its default; volume and pan are
 * keyframeable, so their writes keep the playhead's keyframe in step the way
 * every keyframed prop edit does. The inspector's audio panel, the audio
 * DAPI tool, and any future audio shortcut all funnel through these, so one
 * semantic (clamp, rounding, keyframe sync) holds everywhere.
 */

import { syncKeyframe } from "./keyframes";

import type { Entity, World } from "koota";
import type { DocumentEditor } from "./editor";

/** The gain floor the panel's knob and fields clamp to. */
export const MIN_DB = -60;
/** The gain ceiling the panel's knob and fields clamp to. */
export const MAX_DB = 12;

/**
 * Sets the node's gain in dB (0 is unity), rounded to whole decibels the way
 * the panel shows it; a keyframed volume takes the value at the playhead.
 * Returns the gain written.
 */
export function setGain(world: World, editor: DocumentEditor, entity: Entity, db: number): number {
  const next = Math.round(Math.max(MIN_DB, Math.min(MAX_DB, db)));
  editor.editProperty(entity, "volume", next === 0 ? false : next);
  syncKeyframe(world, editor, entity, "volume", next);
  return next;
}

/**
 * Sets the head fade in seconds (a linear ramp from silence), cleared at 0.
 * Returns the fade written.
 */
export function setFadeIn(editor: DocumentEditor, entity: Entity, seconds: number): number {
  const next = Math.round(Math.max(0, seconds) * 100) / 100;
  editor.editProperty(entity, "fadeIn", next === 0 ? false : next);
  return next;
}

/**
 * Sets the tail fade in seconds (a linear ramp into silence), cleared at 0.
 * Returns the fade written.
 */
export function setFadeOut(editor: DocumentEditor, entity: Entity, seconds: number): number {
  const next = Math.round(Math.max(0, seconds) * 100) / 100;
  editor.editProperty(entity, "fadeOut", next === 0 ? false : next);
  return next;
}

/**
 * Sets the stereo position (-1 hard left, 1 hard right), rounded to
 * hundredths; a keyframed pan takes the value at the playhead. Returns the
 * pan written.
 */
export function setPan(world: World, editor: DocumentEditor, entity: Entity, value: number): number {
  const next = Math.round(Math.max(-1, Math.min(1, value)) * 100) / 100;
  editor.editProperty(entity, "pan", next === 0 ? false : next);
  syncKeyframe(world, editor, entity, "pan", next);
  return next;
}

/** Mutes or unmutes the node: `muted` is a prop, so it survives reload. */
export function setMuted(editor: DocumentEditor, entity: Entity, muted: boolean): void {
  editor.editProperty(entity, "muted", muted);
}
