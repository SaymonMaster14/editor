/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Cache, FrameRate, Keyframe as KeyframeTrait, colorToHex, framesToSeconds } from "@diffusionstudio/runtime";
import { DapiError } from "@diffusionstudio/dapi";
import { getDocumentEditor } from "@/engine/editor";
import {
  deleteKeyframe,
  findKeyframeAt,
  findKeyframeTrack,
  keyframeFrame,
  moveKeyframe,
  setKeyframeValue,
  writeKeyframe,
} from "@/engine/keyframes";
import { resolveNode } from "../lib/nodes";

import type { AnimatableProperty } from "@diffusionstudio/jsx";
import type { Entity, World } from "koota";
import type { ToolHandler } from "../handler";

type ReportedKeyframe = { frame: number; seconds: number; value: number | string; easing: string };

/** A keyframe as the answer spells it: clip-local frame, seconds, held value, easing. */
function reported(world: World, keyframe: Entity, property: string): ReportedKeyframe {
  const fps = world.get(FrameRate)?.value ?? 30;
  const trait = keyframe.get(KeyframeTrait)!;
  const frame = Math.round(trait.time);
  return {
    frame,
    seconds: Math.round(framesToSeconds(frame, fps) * 1000) / 1000,
    value: property === "color" ? colorToHex(trait.value) : trait.value,
    easing: trait.easing,
  };
}

/** The track's keyframes earliest first, as the answer spells them. */
function listed(world: World, track: Entity, property: string): ReportedKeyframe[] {
  return (track.get(Cache)?.keyframes ?? [])
    .map((keyframe) => reported(world, keyframe, property))
    .sort((a, b) => a.frame - b.frame);
}

export const keyframe: ToolHandler<"keyframe"> = async (
  { op, target, property, frame, to, value },
  ctx,
) => {
  const { world } = ctx.requireSession();
  const editor = getDocumentEditor(world);
  const node = resolveNode(world, target);
  const prop = property as AnimatableProperty;

  if (op === "list") {
    const track = findKeyframeTrack(world, node, prop);
    if (!track) {
      return { op, summary: `${target}'s ${property} holds no keyframes` };
    }
    const keyframes = listed(world, track, property);
    return {
      op,
      summary: keyframes.length === 0
        ? `${target}'s ${property} holds no keyframes`
        : `${target}'s ${property} holds ${keyframes.length} keyframe${keyframes.length === 1 ? "" : "s"} at frame${keyframes.length === 1 ? "" : "s"} ${keyframes.map((k) => k.frame).join(", ")}`,
      keyframes,
    };
  }

  if (op === "add") {
    const added = value === undefined
      ? writeKeyframe(world, editor, node, prop)
      : writeKeyframe(world, editor, node, prop, value);
    if (!added) {
      throw new DapiError("invalid-input", `${target}'s ${property} cannot be keyframed — it needs a node above it in a scene, and a property the JSX names (x, y, opacity, volume, ...).`);
    }
    const at = Math.round(added.get(KeyframeTrait)!.time);
    return {
      op,
      summary: `keyframed ${target}'s ${property} at frame ${at}`,
      keyframe: reported(world, added, property),
      keyframes: listed(world, findKeyframeTrack(world, node, prop)!, property),
    };
  }

  const track = findKeyframeTrack(world, node, prop);
  if (!track) {
    throw new DapiError("not-found", `${target}'s ${property} holds no keyframes — add one first.`);
  }
  const at = frame ?? keyframeFrame(node) ?? 0;
  const found = findKeyframeAt(track, at);

  if (op === "remove") {
    if (!found) {
      throw new DapiError("not-found", `no keyframe stands at frame ${at} on ${target}'s ${property} — list the track first.`);
    }
    deleteKeyframe(editor, found);
    return { op, summary: `removed the keyframe at frame ${at} on ${target}'s ${property}` };
  }

  if (op === "move") {
    if (to === undefined) {
      throw new DapiError("invalid-input", "move needs to (the destination frame in the clip's own time).");
    }
    if (!found) {
      throw new DapiError("not-found", `no keyframe stands at frame ${at} on ${target}'s ${property} — list the track first.`);
    }
    if (!moveKeyframe(world, editor, found, to)) {
      throw new DapiError("invalid-input", `cannot move the keyframe from frame ${at} to frame ${to} — another keyframe already stands at ${to}.`);
    }
    return {
      op,
      summary: `moved the keyframe from frame ${at} to frame ${to} on ${target}'s ${property}`,
      keyframe: reported(world, found, property),
    };
  }

  if (value === undefined) {
    throw new DapiError("invalid-input", "set needs value (the number the keyframe holds; CSS hex on a color track).");
  }
  if (!found) {
    throw new DapiError("not-found", `no keyframe stands at frame ${at} on ${target}'s ${property} — add one first.`);
  }
  setKeyframeValue(editor, found, value);
  return {
    op,
    summary: `set the keyframe at frame ${at} on ${target}'s ${property} to ${value}`,
    keyframe: reported(world, found, property),
  };
};
