/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AssetId, Cache, Computed, FrameRate, Hidden, Opacity, Scene, Source, Workarea,
  framesToSeconds, getLibrary, getSceneAncestor,
} from "@diffusionstudio/runtime";
import { escalationFor } from "@diffusionstudio/assets";
import {
  DapiError, judgeProgram, judgeScene,
} from "@diffusionstudio/dapi";

import { resolveNode } from "../lib/nodes";
import { drawsPixels, kindOf } from "./check";

import type { IntegrityAssetRef, IntegrityIssue, IntegritySceneFacts } from "@diffusionstudio/dapi";
import type { Asset } from "@diffusionstudio/assets";
import type { Entity, World } from "koota";
import type { ToolHandler } from "../handler";

// Absolute frames, [start, end).
type Interval = { start: number; end: number };

/** check.ts kinds that count as editable native structure when visible. Media
 *  leaves never do; groups and sequences don't either — a wrapper around one
 *  clip is not a composition, and a real multi-clip sequence defeats
 *  single-asset dominance on its own. */
const EDITABLE_KINDS = new Set(["text", "caption", "shape", "html", "adjustment-layer", "mask"]);

type WalkState = {
  nodes: number;
  byKind: Record<string, number>;
  editableNodes: number;
  animatedProperties: number;
  masks: number;
  /** Visible video spans per asset id. */
  coverage: Map<string, Interval[]>;
};

/**
 * One pass over the subtree, mirroring the check handler's visibility
 * semantics (hidden, statically transparent, zero-duration, and
 * out-of-window nodes contribute nothing) without its issue reporting:
 * count, classify, and collect the intervals each video asset draws.
 */
function visit(entity: Entity, window: Interval | null, state: WalkState): void {
  state.nodes += 1;
  const kind = kindOf(entity);
  state.byKind[kind] = (state.byKind[kind] ?? 0) + 1;
  if (kind === "mask") {
    // Masks are pure authoring — they shape other nodes' pixels — so they
    // count as structure wherever they stand (check visits them windowless).
    state.editableNodes += 1;
    state.masks += 1;
  }

  const computed = entity.get(Computed)!;
  let visible = window;
  if (computed.duration === 0) visible = null;
  if (entity.has(Hidden)) visible = null;

  const tracks = entity.get(Cache)?.keyframeTracks.length ?? 0;
  state.animatedProperties += tracks;
  if (entity.get(Opacity)?.value === 0 && tracks === 0) visible = null;

  if (visible !== null) {
    const start = Math.max(visible.start, computed.start);
    const end = Math.min(visible.end, computed.end);
    visible = start >= end ? null : { start, end };
  }

  if (visible !== null) {
    if ((EDITABLE_KINDS.has(kind) && kind !== "mask") || tracks > 0) state.editableNodes += 1;
    if (kind === "video" && drawsPixels(entity)) {
      const assetId = entity.get(AssetId)?.value;
      // No AssetId, no resolved bytes: nothing renders, so nothing can
      // dominate (the check tool owns load failures).
      if (assetId) {
        const spans = state.coverage.get(assetId) ?? [];
        spans.push(visible);
        state.coverage.set(assetId, spans);
      }
    }
  }

  const cache = entity.get(Cache);
  for (const child of cache?.children ?? []) visit(child, visible, state);
  for (const mask of cache?.masks ?? []) visit(mask, null, state);
}

function assetRef(asset: Asset | undefined, assetId: string): IntegrityAssetRef {
  if (!asset) {
    return { id: assetId, path: assetId, source: "", transient: false, hasProvenance: false, hasGeneration: false, hasEscalation: false };
  }
  return {
    id: asset.id,
    path: asset.path,
    source: asset.source,
    transient: asset.transient ?? false,
    hasProvenance: asset.provenance !== undefined,
    hasGeneration: asset.generation !== undefined,
    hasEscalation: asset.escalation !== undefined,
  };
}

function factsFor(world: World, target: Entity, stamp: string): { facts: IntegritySceneFacts; duration: number; nodes: number; byKind: Record<string, number>; editableNodes: number; animatedProperties: number; masks: number } {
  const fps = world.get(FrameRate)?.value ?? 30;
  const computed = target.get(Computed)!;

  // The span the node actually plays — the same workarea-aware window the
  // check handler reads, so both tools speak one clock.
  let window: Interval = { start: computed.start, end: computed.end };
  const workarea = target.get(Workarea);
  if (workarea) {
    const start = Math.min(computed.end, computed.start + Math.max(0, workarea.start));
    const end = Math.max(start, Math.min(computed.end, workarea.end ? computed.start + workarea.end : computed.end));
    window = { start, end };
  }

  const state: WalkState = { nodes: 0, byKind: {}, editableNodes: 0, animatedProperties: 0, masks: 0, coverage: new Map() };
  visit(target, window, state);

  const library = getLibrary(world);
  const coverage = [...state.coverage.entries()].map(([assetId, spans]) => ({ assetId, spans }));
  const assets = [...state.coverage.keys()].map((assetId) => assetRef(library.get(assetId), assetId));
  return {
    facts: { id: stamp, windowFrames: window.end - window.start, coverage, editableNodes: state.editableNodes, assets },
    duration: Math.round(framesToSeconds(window.end - window.start, fps) * 1000) / 1000,
    nodes: state.nodes,
    byKind: state.byKind,
    editableNodes: state.editableNodes,
    animatedProperties: state.animatedProperties,
    masks: state.masks,
  };
}

/** Top-level scenes, earliest-stamped first — nested scenes report through their root. */
function programScenes(world: World): Entity[] {
  return world
    .query(Scene)
    .filter((scene) => getSceneAncestor(scene) === null)
    .sort((a, b) => (a.get(Source)?.value ?? "").localeCompare(b.get(Source)?.value ?? ""));
}

export const productionIntegrity: ToolHandler<"production_integrity"> = async (
  { op, id, asset, tool, reason, scope, missingCapability },
  ctx,
) => {
  const { world } = ctx.requireSession();

  if (op === "record-escalation") {
    if (!asset || !tool?.trim() || !reason?.trim() || !scope) {
      throw new DapiError("invalid-input", "record-escalation needs asset, tool, reason, and scope — a receipt with a blank field justifies nothing.");
    }
    const library = getLibrary(world);
    const found = library.get(asset);
    if (!found) {
      const partial = library.getPartial(asset);
      throw new DapiError(
        "not-found",
        partial
          ? `"${asset}" is a generation without bytes yet — record the escalation once it lands.`
          : `No such asset: "${asset}" — import it into the library first, then declare it.`,
      );
    }
    if (found.transient) {
      throw new DapiError("invalid-input", `"${asset}" is transient bytes, never written to the manifest — import it into the library first so the receipt has an asset to live on.`);
    }
    const escalation = escalationFor({ tool: tool.trim(), reason: reason.trim(), scope, ...(missingCapability?.trim() ? { missingCapability: missingCapability.trim() } : {}) });
    const replacing = found.escalation !== undefined;
    library.update(found, { escalation });
    await library.flush();
    return {
      op,
      summary: `${replacing ? "replaced the standing receipt on" : "declared"} ${found.path}: ${escalation.tool} (${escalation.scope}) — ${escalation.reason}`,
      escalation,
    };
  }

  // op === "check"
  const targets = id !== undefined ? [resolveNode(world, id)] : programScenes(world);
  if (targets.length === 0) {
    throw new DapiError("not-found", "The program holds no scene to check — open a project with a scene first.");
  }
  for (const target of targets) {
    if (!target.has(Scene)) {
      const stamp = target.get(Source)?.value ?? id ?? "that node";
      throw new DapiError("wrong-kind", `"${stamp}" is not a scene — production integrity judges scenes (or the whole program with no id).`);
    }
  }
  const gathered = targets.map((target) => {
    const stamp = target.get(Source)?.value;
    if (!stamp) throw new DapiError("not-found", "A scene without a source stamp cannot be checked — reopen the project and retry.");
    return { stamp, ...factsFor(world, target, stamp) };
  });

  const program = id === undefined
    ? judgeProgram(gathered.map((g) => g.facts))
    : { scenes: gathered.map((g) => judgeScene(g.facts)), issues: [] as IntegrityIssue[], verdict: "pass" as const };
  const verdict = program.issues.some((issue) => issue.severity === "error") ||
    program.scenes.some((scene) => scene.issues.some((issue) => issue.severity === "error"))
    ? "fail"
    : "pass";
  const errors = program.issues.filter((issue) => issue.severity === "error").length +
    program.scenes.reduce((sum, scene) => sum + scene.issues.filter((issue) => issue.severity === "error").length, 0);
  const warnings = program.issues.filter((issue) => issue.severity === "warning").length +
    program.scenes.reduce((sum, scene) => sum + scene.issues.filter((issue) => issue.severity === "warning").length, 0);

  return {
    op,
    summary: verdict === "fail"
      ? `fail: ${errors} error${errors === 1 ? "" : "s"} across ${program.scenes.length} scene${program.scenes.length === 1 ? "" : "s"} — the agent is not done`
      : `pass: ${program.scenes.length} scene${program.scenes.length === 1 ? "" : "s"} checked, ${warnings} warning${warnings === 1 ? "" : "s"}`,
    verdict,
    scenes: program.scenes.map((scene, index) => {
      const g = gathered[index]!;
      return {
        id: scene.sceneId,
        duration: g.duration,
        stats: { nodes: g.nodes, byKind: g.byKind, editableNodes: g.editableNodes, animatedProperties: g.animatedProperties, masks: g.masks },
        dominant: scene.dominant ? { asset: scene.dominant.ref.path, role: scene.dominant.role, coverage: Math.round(scene.dominant.coverage * 1000) / 1000 } : null,
        issues: scene.issues,
      };
    }),
    issues: program.issues,
  };
};
