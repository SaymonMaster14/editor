/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Fade, Muted, Pan, Volume } from "@diffusionstudio/runtime";
import { DapiError } from "@diffusionstudio/dapi";
import { setFadeIn, setFadeOut, setGain, setMuted, setPan } from "@/engine/audio";
import { getDocumentEditor } from "@/engine/editor";
import { resolveNode } from "../lib/nodes";

import type { Entity } from "koota";
import type { ToolHandler } from "../handler";

/** The node's audio as the answer spells it: gain, fades, pan, mute. */
function reported(entity: Entity) {
  return {
    gain: entity.get(Volume)?.value ?? 0,
    fadeIn: entity.get(Fade)?.in ?? 0,
    fadeOut: entity.get(Fade)?.out ?? 0,
    pan: entity.get(Pan)?.value ?? 0,
    muted: entity.has(Muted),
  };
}

export const audioEdit: ToolHandler<"audio_edit"> = async (
  { op, target, gain, fadeIn, fadeOut, pan, muted },
  ctx,
) => {
  const { world } = ctx.requireSession();
  const editor = getDocumentEditor(world);
  const node = resolveNode(world, target);

  if (op === "get") {
    const state = reported(node);
    return {
      op,
      summary: `${target} sits at ${state.gain} dB${state.muted ? ", muted" : ""}, fades ${state.fadeIn}s in / ${state.fadeOut}s out, pan ${state.pan}`,
      audio: state,
    };
  }

  // The engine clamps; what it cannot take is a non-number, refused here
  // with the field named rather than written as NaN into the file.
  for (const [name, value] of [["gain", gain], ["fadeIn", fadeIn], ["fadeOut", fadeOut], ["pan", pan]] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new DapiError("invalid-input", `${name} must be a finite number, got ${value}.`);
    }
  }

  const wrote: string[] = [];
  if (gain !== undefined) {
    wrote.push(`gain ${setGain(world, editor, node, gain)} dB`);
  }
  if (fadeIn !== undefined) {
    wrote.push(`fade in ${setFadeIn(editor, node, fadeIn)}s`);
  }
  if (fadeOut !== undefined) {
    wrote.push(`fade out ${setFadeOut(editor, node, fadeOut)}s`);
  }
  if (pan !== undefined) {
    wrote.push(`pan ${setPan(world, editor, node, pan)}`);
  }
  if (muted !== undefined) {
    setMuted(editor, node, muted);
    wrote.push(muted ? "muted" : "unmuted");
  }
  if (!wrote.length) {
    throw new DapiError("invalid-input", "set needs at least one of gain, fadeIn, fadeOut, pan, muted.");
  }

  return {
    op,
    summary: `set ${target}'s ${wrote.join(", ")}`,
    audio: reported(node),
  };
};
