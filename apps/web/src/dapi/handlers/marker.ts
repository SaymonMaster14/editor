/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FrameRate, framesToSeconds, secondsToFrames } from "@diffusionstudio/runtime";
import { DapiError } from "@diffusionstudio/dapi";
import {
  addMarker,
  clearMarkers,
  listMarkers,
  moveMarker,
  removeMarker,
  seekMarker,
} from "@/engine/markers";
import { getEditHistory } from "@/engine/history";

import type { SceneMarker } from "@diffusionstudio/runtime";
import type { World } from "koota";
import type { ToolHandler } from "../handler";

/** A flag as the answer spells it: its frame, its seconds, its label, its color. */
function reported(world: World, marker: SceneMarker) {
  const fps = world.get(FrameRate)?.value ?? 30;
  return {
    at: marker.at,
    seconds: Math.round(framesToSeconds(marker.at, fps) * 1000) / 1000,
    name: marker.name,
    color: marker.color,
  };
}

export const marker: ToolHandler<"marker"> = async (
  { op, at, from, to, name, color, direction },
  ctx,
) => {
  const { world } = ctx.requireSession();
  const fps = world.get(FrameRate)?.value ?? 30;
  const frames = (seconds: number) => secondsToFrames(seconds, fps);

  if (op === "list") {
    const markers = listMarkers(world);
    return {
      op,
      summary: markers.length === 0
        ? "the scene holds no markers"
        : `the scene holds ${markers.length} marker${markers.length === 1 ? "" : "s"}: ${markers.map((m) => `${m.name || "Marker"} at frame ${m.at}`).join(", ")}`,
      markers: markers.map((m) => reported(world, m)),
    };
  }

  if (op === "add") {
    getEditHistory(world).labelStep("Agent — add marker");
    const added = addMarker(world, {
      ...(at !== undefined ? { at: frames(at) } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(color !== undefined ? { color } : {}),
    });
    if (!added) {
      throw new DapiError("invalid-input", "add found no scene to pin to — open a project with a scene first.");
    }
    return {
      op,
      summary: `pinned ${added.name || "Marker"} at frame ${added.at} (${reported(world, added).seconds}s)`,
      marker: reported(world, added),
    };
  }

  if (op === "remove") {
    const target = at !== undefined ? frames(at) : undefined;
    getEditHistory(world).labelStep("Agent — remove marker");
    if (!removeMarker(world, target === undefined ? {} : { at: target })) {
      throw new DapiError(
        "not-found",
        target === undefined
          ? "no marker stands at the playhead — pass at, or list the flags first."
          : `no marker stands at frame ${target} — list the flags first.`,
      );
    }
    return { op, summary: `removed the marker at frame ${target ?? "the playhead"}` };
  }

  if (op === "move") {
    if (from === undefined || to === undefined) {
      throw new DapiError("invalid-input", "move needs from and to (the flag's position and where it goes).");
    }
    getEditHistory(world).labelStep("Agent — move marker");
    const source = frames(from);
    const destination = frames(to);
    if (!moveMarker(world, { from: source, to: destination })) {
      throw new DapiError(
        "invalid-input",
        `cannot move the flag from frame ${source} to frame ${destination} — no flag stands at ${source}, or one already stands at ${destination}.`,
      );
    }
    const moved = listMarkers(world).find((m) => m.at === destination)!;
    return { op, summary: `moved the marker from frame ${source} to frame ${destination}`, marker: reported(world, moved) };
  }

  if (op === "seek") {
    if (!direction) throw new DapiError("invalid-input", "seek needs direction (next or prev).");
    const found = seekMarker(world, { direction });
    if (!found) {
      throw new DapiError("not-found", `no marker ${direction === "next" ? "past" : "before"} the playhead.`);
    }
    return {
      op,
      summary: `jumped ${direction} to ${found.name || "Marker"} at frame ${found.at}`,
      marker: reported(world, found),
    };
  }

  // Label only when flags exist to clear: a no-op must not name the next step.
  if (listMarkers(world).length > 0) getEditHistory(world).labelStep("Agent — clear markers");
  if (!clearMarkers(world)) {
    return { op, summary: "the scene holds no markers" };
  }
  return { op, summary: "cleared all markers" };
};
