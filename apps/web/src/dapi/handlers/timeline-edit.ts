/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Computed, getActiveEntity, getParentEntity, Name, Source, store } from "@diffusionstudio/runtime";
import { DapiError } from "@diffusionstudio/dapi";
import { getEditHistory } from "@/engine/history";
import { clipSpan, extract, lift, rippleTrimIn, rippleTrimOut, rippleTrimPreviousToPlayhead, roll, siblingsInTime, slide, slip } from "@/engine/nle";
import { splitAtPlayhead, splitClipAtFrame } from "@/engine/split";
import { moveEntityTo, trimIn, trimOut } from "@/engine/timing";
import { resolveNode } from "../lib/nodes";

import type { Entity, World } from "koota";
import type { ToolHandler } from "../handler";

/** The node's source stamp, falling back to its name while a rename is pending. */
function stamp(entity: Entity): string {
  return entity.get(Source)?.value ?? entity.get(Name)?.value ?? "?";
}

function spansOf(world: World, entities: Entity[]): Record<string, { start: number; end: number }> {
  void world;
  const spans: Record<string, { start: number; end: number }> = {};
  for (const entity of entities) spans[stamp(entity)] = clipSpan(entity);
  return spans;
}

export const timelineEdit: ToolHandler<"timeline_edit"> = async ({ op, target, frame, delta, targets }, ctx) => {
  const { world } = ctx.requireSession();
  if (op === "undo" || op === "redo") {
    const history = getEditHistory(world);
    const can = op === "undo" ? history.canUndo() : history.canRedo();
    if (!can) throw new DapiError("invalid-input", `nothing to ${op}.`);
    if (op === "undo") history.undo();
    else history.redo();
    return { op, summary: `${op} applied`, spans: {} };
  }
  if (op === "split" && !target) {
    getEditHistory(world).labelStep("Agent — split");
    const tails = splitAtPlayhead(world);
    if (tails.length === 0) throw new DapiError("invalid-input", "nothing under the playhead to split.");
    return { op, summary: `split ${tails.length} clip(s) at the playhead`, spans: spansOf(world, tails) };
  }
  if (!target) throw new DapiError("invalid-input", `${op} needs target (a node id).`);
  const node = resolveNode(world, target);
  const extra = (targets ?? []).map((id) => resolveNode(world, id));
  if (op === "list") {
    const parent = getParentEntity(node) ?? node;
    const siblings = siblingsInTime(parent);
    return {
      op,
      target,
      summary: `${siblings.length} timeline clips under ${stamp(parent)}`,
      spans: spansOf(world, siblings),
    };
  }

  getEditHistory(world).labelStep(`Agent — ${op}`);
  switch (op) {
    case "split": {
      let at = frame;
      if (at === undefined) {
        const scene = getActiveEntity(world);
        if (scene === null) throw new DapiError("invalid-input", "split needs frame or an open scene to take the playhead from.");
        at = store(world, Computed).localTime[scene.id()] ?? 0;
      }
      const tail = splitClipAtFrame(world, node, at);
      if (!tail) throw new DapiError("invalid-input", `frame ${at} is not inside "${target}".`);
      return { op, target, summary: `split ${target} at frame ${at}`, spans: spansOf(world, [node, tail]) };
    }
    case "lift": {
      // Named before they go: a removed entity's traits go with it, so
      // stamping the answer afterwards reads "?" off every one of them.
      const names = new Map<Entity, string>([node, ...extra].map((entity) => [entity, stamp(entity)]));
      const removed = lift(world, [node, ...extra]);
      const ids = removed.map((entity) => names.get(entity) ?? stamp(entity));
      return {
        op,
        target,
        summary: `lifted ${ids.join(", ") || target}; the gap stays`,
        spans: {},
        removed: ids,
      };
    }
    case "extract": {
      const names = new Map<Entity, string>([node, ...extra].map((entity) => [entity, stamp(entity)]));
      const { removed, shifted, delta: closed } = extract(world, [node, ...extra]);
      const ids = removed.map((entity) => names.get(entity) ?? stamp(entity));
      return {
        op,
        target,
        summary: `extracted ${ids.join(", ")} and closed ${closed} frames`,
        spans: spansOf(world, shifted),
        removed: ids,
        shifted: shifted.map(stamp),
      };
    }
    case "rippleTrimIn":
    case "rippleTrimOut":
    case "rippleTrimPreviousToPlayhead": {
      if (frame === undefined) throw new DapiError("invalid-input", `${op} needs frame (the destination timeline frame).`);
      let applied: number;
      if (op === "rippleTrimIn") applied = rippleTrimIn(world, node, frame);
      else if (op === "rippleTrimOut") applied = rippleTrimOut(world, node, frame);
      else applied = rippleTrimPreviousToPlayhead(world, node, frame);
      return {
        op,
        target,
        summary: `ripple-trimmed ${target} by ${applied} frames`,
        spans: spansOf(world, [node]),
      };
    }
    case "roll": {
      if (frame === undefined) throw new DapiError("invalid-input", "roll needs frame (the destination edit point).");
      const pair = roll(world, node, frame);
      if (!pair) throw new DapiError("invalid-input", `nothing abuts the end of "${target}" — a roll needs two clips touching.`);
      const clamped = pair.applied !== frame ? ` (the source has no handle past frame ${pair.applied})` : "";
      return {
        op,
        target,
        summary: `rolled the ${target}/${stamp(pair.right)} edit point to frame ${pair.applied}${clamped}`,
        spans: spansOf(world, [pair.left, pair.right]),
      };
    }
    case "slip": {
      if (delta === undefined) throw new DapiError("invalid-input", "slip needs delta (source frames to shift).");
      const applied = slip(world, node, delta);
      return {
        op,
        target,
        summary: applied === 0 ? `slip of ${target} applied nothing (no room in the source)` : `slipped ${target} by ${applied} source frames`,
        spans: spansOf(world, [node]),
      };
    }
    case "slide": {
      if (delta === undefined) throw new DapiError("invalid-input", "slide needs delta (timeline frames to shift).");
      const applied = slide(world, node, delta);
      return {
        op,
        target,
        summary: applied === 0 ? `slide of ${target} applied nothing (no abutting neighbor or handle)` : `slid ${target} by ${applied} frames`,
        spans: spansOf(world, [node]),
      };
    }
    case "move": {
      if (frame === undefined) throw new DapiError("invalid-input", "move needs frame (the destination start frame).");
      moveEntityTo(world, node, frame);
      return { op, target, summary: `moved ${target} to start at frame ${frame}`, spans: spansOf(world, [node]) };
    }
    case "trimIn":
    case "trimOut": {
      if (frame === undefined) throw new DapiError("invalid-input", `${op} needs frame (the destination edge frame).`);
      if (op === "trimIn") trimIn(world, node, frame);
      else trimOut(world, node, frame);
      return { op, target, summary: `trimmed ${target} ${op === "trimIn" ? "in" : "out"} to frame ${frame}`, spans: spansOf(world, [node]) };
    }
  }
};
