/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Library, Name, Source } from "@diffusionstudio/runtime";
import { DapiError } from "@diffusionstudio/dapi";
import { isPendingSource } from "@/engine/editor";
import { clipSpan } from "@/engine/nle";
import { getEditHistory } from "@/engine/history";
import {
  insertEdit,
  loadSourceMonitor,
  markIn,
  markOut,
  overwriteEdit,
  scrubSourceMonitor,
} from "@/engine/source-edit";
import { SourceMonitor } from "@/engine/traits";
import { resolveNode } from "../lib/nodes";

import type { Entity, World } from "koota";
import type { ToolHandler } from "../handler";

/**
 * A fresh element's stamp once the file sync has answered it with its real
 * source — the address the caller can point at next. The writer follows
 * ~120ms after the last edit, so this is usually one or two polls; past
 * ten seconds the sync is not coming (a declined write) and whatever stamp
 * the entity holds is the honest answer.
 */
async function settledStamp(entity: Entity): Promise<string> {
  const start = Date.now();
  for (;;) {
    const value = entity.get(Source)?.value;
    if (!value || !isPendingSource(value) || Date.now() - start > 10_000) {
      return value ?? entity.get(Name)?.value ?? "?";
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What the monitor holds, for the answer — undefined while it holds nothing. */
function monitorOf(world: World): { assetId: string; in: number; out: number } | undefined {
  const monitor = world.get(SourceMonitor);
  if (!monitor?.assetId) return undefined;
  return { assetId: monitor.assetId, in: monitor.in, out: monitor.out };
}

/** The library asset an id or path names, or the error that says it names none. */
function resolveAsset(world: World, asset: string) {
  const found = world.get(Library)?.get(asset);
  if (!found) {
    throw new DapiError("not-found", `No such asset: "${asset}" — asset ids and paths come from the library panel or assets_search.`);
  }
  return found;
}

export const sourceEdit: ToolHandler<"source_edit"> = async (
  { op, asset, at, in: inPoint, out: outPoint, frame, parent },
  ctx,
) => {
  const { world } = ctx.requireSession();
  if (op === "range") {
    const range = monitorOf(world);
    return {
      op,
      summary: range
        ? `the monitor holds ${range.assetId}, ranged ${range.in}s–${range.out}s`
        : "the monitor holds nothing",
      ...(range ? { range } : {}),
    };
  }
  if (op === "load") {
    if (!asset) throw new DapiError("invalid-input", "load needs asset (a library asset id or path).");
    const found = resolveAsset(world, asset);
    loadSourceMonitor(world, found.id);
    const range = monitorOf(world)!;
    return { op, summary: `loaded ${found.path} into the source monitor`, range };
  }
  if (op === "markIn" || op === "markOut" || op === "scrub") {
    if (!monitorOf(world)) {
      throw new DapiError("invalid-input", `${op} needs a loaded monitor — load an asset first.`);
    }
    if (op === "scrub" && at === undefined) {
      throw new DapiError("invalid-input", "scrub needs at (the source position in seconds).");
    }
    if (op === "markIn") markIn(world, at);
    else if (op === "markOut") markOut(world, at);
    else scrubSourceMonitor(world, at!);
    const range = monitorOf(world)!;
    const verb = op === "markIn" ? "marked in" : op === "markOut" ? "marked out" : "scrubbed to";
    const point = op === "markIn" ? range.in : op === "markOut" ? range.out : at!;
    return { op, summary: `${verb} ${point}s on ${range.assetId} (range ${range.in}s–${range.out}s)`, range };
  }

  const assetId = asset ? resolveAsset(world, asset).id : undefined;
  const parentEntity = parent ? resolveNode(world, parent) : undefined;
  const options = {
    ...(assetId ? { assetId } : {}),
    ...(inPoint !== undefined ? { in: inPoint } : {}),
    ...(outPoint !== undefined ? { out: outPoint } : {}),
    ...(frame !== undefined ? { at: frame } : {}),
    ...(parentEntity ? { parent: parentEntity } : {}),
  };
  getEditHistory(world).labelStep(`Agent — ${op}`);
  const report = op === "insert" ? insertEdit(world, options) : overwriteEdit(world, options);
  if (!report) {
    throw new DapiError(
      "invalid-input",
      assetId || monitorOf(world)
        ? `${op} found nothing to land under — open a project with a scene first.`
        : `${op} needs an asset — pass asset, or load the monitor and mark a range.`,
    );
  }
  const placed = await settledStamp(report.entity);
  const span = clipSpan(report.entity);
  const verb = op === "insert" ? "inserted" : "overwrote";
  return {
    op,
    summary: `${verb} ${assetId ?? monitorOf(world)?.assetId} at frame ${report.at} as ${placed} (frames ${span.start}–${span.end})`,
    range: monitorOf(world),
    placed,
    span,
  };
};
