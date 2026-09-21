/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Animation, AnimationPhase, Cache, Computed, FrameRate, Keyframe,
  Source, WorldBounds, WorldTransform, framesToSeconds, invert2D, store,
  transformPoint,
} from "@diffusionstudio/runtime";
import { createImageEncoder, decodePng } from "@diffusionstudio/encoder";
import { TIME_FPS } from "@diffusionstudio/jsx";
import {
  DapiError, detectLayoutIssues, framePixelStats, selectSweepPositions,
} from "@diffusionstudio/dapi";
import { createCapture } from "@/engine/capture";
import { requireScene } from "../lib/scene";
import { SheetCollector } from "../lib/sheets";
import { check, drawsPixels, kindOf } from "./check";

import type {
  QaFinding, QaFrameAnalysis, QaLandmark, QaLayoutNode, QaSweepMode,
} from "@diffusionstudio/dapi";
import type { Entity, World } from "koota";
import type { ToolHandler } from "../handler";

const SHEET_CAPTURE_HEIGHT = 1080;
/** Landmark collection stops here; selection caps the rendered frames anyway. */
const MAX_LANDMARKS = 500;
/** Receipts stay readable: findings past this are dropped. */
const MAX_FINDINGS = 100;

function stampOf(entity: Entity, fallback: string): string {
  return entity.get(Source)?.value ?? fallback;
}

function stampShort(stamp: string): string {
  return stamp.length > 24 ? `${stamp.slice(0, 21)}...` : stamp;
}

type Span = { start: number; end: number };

function subtree(scene: Entity): Entity[] {
  const out: Entity[] = [];
  const stack: Entity[] = [scene];
  while (stack.length > 0) {
    const next = stack.pop()!;
    out.push(next);
    for (const child of next.get(Cache)?.children ?? []) stack.push(child);
  }
  return out;
}

/**
 * Timeline events worth a look, in live-world frames: clip entrances and
 * exits, text/caption entrances, keyframes, animation peaks, and the middle
 * of every gap `check` flags. The caller maps them onto the capture clock.
 */
function collectLandmarks(world: World, scene: Entity, window: Span, gaps: Span[]): QaLandmark[] {
  const landmarks: QaLandmark[] = [];
  const push = (frame: number, reason: string, priority: number): void => {
    if (landmarks.length >= MAX_LANDMARKS) return;
    if (!Number.isFinite(frame)) return;
    landmarks.push({ frame: Math.round(frame), reason, priority });
  };

  const computed = store(world, Computed);
  const cache = store(world, Cache);
  const keyframe = store(world, Keyframe);
  const animation = store(world, Animation);
  for (const entity of subtree(scene)) {
    if (entity === scene || !drawsPixels(entity)) continue;
    const eid = entity.id();
    const start = computed.start[eid] ?? 0;
    const end = computed.end[eid] ?? 0;
    const kind = kindOf(entity);
    const label = stampShort(stampOf(entity, kind));
    const textish = kind === "text" || kind === "caption";
    if (start > window.start) push(start, `${textish ? "text-enter" : "clip-enter"}:${label}`, textish ? 20 : 10);
    if (end < window.end) push(end, `clip-exit:${label}`, 7);

    for (const track of cache.keyframeTracks[eid] ?? []) {
      const tid = track.id();
      for (const kf of cache.keyframes[tid] ?? []) {
        push(start + (keyframe.time[kf.id()] ?? 0), "keyframe", 5);
      }
    }
    for (const anim of cache.animations[eid] ?? []) {
      const aid = anim.id();
      const duration = animation.duration[aid] ?? 0;
      if (duration <= 0) continue;
      const delay = animation.delay[aid] ?? 0;
      const out = animation.phase[aid] === AnimationPhase.OUT;
      const local = out ? end - start - delay - duration / 2 : delay + duration / 2;
      push(start + local, "animation-peak", 6);
    }
  }

  for (const gap of gaps) {
    if (gap.end - gap.start >= 1) push((gap.start + gap.end) / 2, "gap-mid", 15);
  }
  return landmarks;
}

/**
 * The visual leaves' boxes at one rendered frame of the capture world, in
 * the scene's own units. Called from the encoder's onFrame hook, after the
 * systems pass, so WorldBounds is fresh; `sceneFrame` is the live-world
 * frame the capture frame shows, for the visibility window.
 *
 * WorldBounds holds post-camera, post-resolution device pixels (see
 * getEntityBounds), while the detectors compare against the scene's units,
 * so every box comes back through the inverse of the scene's world matrix,
 * which folds camera, resolution and canvas placement into one inversion.
 * A degenerate scene matrix means nothing can be placed, and the snapshot
 * carries no nodes; the pixel detectors still run.
 */
function snapshotLayout(world: World, scene: Entity, sceneFrame: number): { canvas: { width: number; height: number }; nodes: QaLayoutNode[] } {
  const computed = store(world, Computed);
  const bounds = store(world, WorldBounds);
  const canvas = scene.get(Computed);
  const size = { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };

  const matrices = store(world, WorldTransform);
  const sid = scene.id();
  const sceneMat = {
    a: matrices.a[sid] ?? Number.NaN, b: matrices.b[sid] ?? Number.NaN,
    c: matrices.c[sid] ?? Number.NaN, d: matrices.d[sid] ?? Number.NaN,
    e: matrices.e[sid] ?? Number.NaN, f: matrices.f[sid] ?? Number.NaN,
  };
  const det = sceneMat.a * sceneMat.d - sceneMat.b * sceneMat.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { canvas: size, nodes: [] };
  const toScene = invert2D(sceneMat);

  const nodes: QaLayoutNode[] = [];
  for (const entity of subtree(scene)) {
    if (entity === scene || !drawsPixels(entity)) continue;
    const eid = entity.id();
    const start = computed.start[eid] ?? 0;
    const end = computed.end[eid] ?? 0;
    if (sceneFrame < start || sceneFrame >= end) continue;
    const corners = [
      transformPoint(toScene, bounds.minX[eid] ?? 0, bounds.minY[eid] ?? 0),
      transformPoint(toScene, bounds.maxX[eid] ?? 0, bounds.minY[eid] ?? 0),
      transformPoint(toScene, bounds.minX[eid] ?? 0, bounds.maxY[eid] ?? 0),
      transformPoint(toScene, bounds.maxX[eid] ?? 0, bounds.maxY[eid] ?? 0),
    ];
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const source = entity.get(Source);
    nodes.push({
      ...(source?.value ? { stamp: source.value } : {}),
      kind: kindOf(entity),
      rect: { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY },
      scaleX: computed.scaleX[eid],
      scaleY: computed.scaleY[eid],
    });
  }
  return { canvas: size, nodes };
}

/** Pixels back out of a decoded frame: one draw plus one readback per sampled frame. */
function readPixels(image: ImageBitmap): { data: Uint8Array; width: number; height: number } {
  const scratch = document.createElement("canvas");
  scratch.width = image.width;
  scratch.height = image.height;
  const ctx2d = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx2d.drawImage(image, 0, 0);
  const found = ctx2d.getImageData(0, 0, image.width, image.height);
  return { data: new Uint8Array(found.data.buffer), width: image.width, height: image.height };
}

export const qaSweep: ToolHandler<"qa_sweep"> = async ({ id, mode, maxFrames, times, separate, perSheet }, ctx) => {
  const { world, project } = ctx.requireSession();
  const scene = requireScene(world, id, "qa_sweep");
  const fps = world.get(FrameRate)?.value ?? 30;
  const sweepMode: QaSweepMode = mode ?? "auto";
  const cap = maxFrames ?? 12;

  const sceneComputed = scene.get(Computed)!;
  const window: Span = { start: sceneComputed.start, end: sceneComputed.end };
  // Capture clock: frame 0 is the export's frame 0 — the window's start, in
  // TIME_FPS frames, like capture's shots. Landmarks arrive in live-world
  // frames at the project rate; rescale when those differ.
  const toCapture = (liveFrame: number): number => Math.round(((liveFrame - window.start) * TIME_FPS) / fps);
  const toLive = (captureFrame: number): number => window.start + Math.round((captureFrame * fps) / TIME_FPS);
  const endFrame = Math.max(0, toCapture(window.end - 1));

  // Gaps come from the structural check over the same scene: its ranges are
  // seconds on the scene clock, so back onto live frames via the rate.
  const checked = await check({ id }, ctx);
  const gaps: Span[] = [];
  for (const issue of checked.issues) {
    if (issue.code !== "black-frames" || !issue.ranges) continue;
    for (const range of issue.ranges) {
      gaps.push({ start: window.start + Math.round(range.start * fps), end: window.start + Math.round(range.end * fps) });
    }
  }

  const landmarks = collectLandmarks(world, scene, window, gaps).map((landmark) => ({
    frame: toCapture(landmark.frame),
    reason: landmark.reason,
    priority: landmark.priority,
  }));
  for (const t of times ?? []) landmarks.push({ frame: Math.round(t * TIME_FPS), reason: "requested", priority: 50 });

  const regular: number[] = [];
  if (sweepMode !== "landmarks") {
    const count = Math.min(Math.max(cap, 2), 48);
    for (let i = 0; i < count; i++) regular.push(Math.round((endFrame * i) / Math.max(1, count - 1)));
  }
  const positions = selectSweepPositions({ endFrame, landmarks, regular, mode: sweepMode, maxFrames: cap });
  const shots = positions.map((position) => position.frame);

  const layouts = new Map<number, { canvas: { width: number; height: number }; nodes: QaLayoutNode[] }>();
  const target = await createCapture(world, scene, { dir: project.dir() });
  try {
    const encoder = await createImageEncoder(target.world, {
      frames: shots,
      resolution: 720,
      onFrame: (frame) => {
        layouts.set(frame, snapshotLayout(target.world, target.node, toLive(frame)));
      },
    });

    let sheets: SheetCollector | undefined;
    if (!separate) {
      const aspect = encoder.bounds.width / encoder.bounds.height;
      const height = Math.max(encoder.bounds.height, SHEET_CAPTURE_HEIGHT);
      sheets = new SheetCollector(shots.length, { width: height * aspect, height }, perSheet);
      encoder.resize(sheets.cellHeight);
    }

    const result = await encoder.render();
    if (result.type === "canceled") throw new DapiError("canceled", "QA sweep canceled");
    if (result.type === "error") throw result.error;

    const frames: QaFrameAnalysis[] = [];
    const findings: QaFinding[] = [];
    const pushFinding = (finding: QaFinding): void => {
      if (findings.length < MAX_FINDINGS) findings.push(finding);
    };

    const decoded = new Map<number, Awaited<ReturnType<typeof decodePng>>>();
    for (const [index, { timecode, png }] of result.data.entries()) {
      const at = shots[index]!;
      const image = await decodePng(png);
      decoded.set(at, image);
      const pixels = readPixels(image);
      const stats = framePixelStats(pixels.data, pixels.width, pixels.height);
      const time = Math.round(framesToSeconds(at, TIME_FPS) * 1000) / 1000;
      frames.push({
        frame: at,
        time,
        timecode,
        reasons: positions[index]!.reasons,
        luminance: stats.luminance,
        dark: stats.dark,
        uniform: stats.uniform,
      });
      if (stats.dark) {
        pushFinding({
          code: "rendered-black",
          severity: "warning",
          message: `frame renders black at ${timecode} — gap, missing asset, or empty canvas`,
          frame: at,
          time,
        });
      } else if (stats.uniform) {
        pushFinding({
          code: "rendered-uniform",
          severity: "warning",
          message: `frame renders flat at ${timecode} — nothing varies across the canvas`,
          frame: at,
          time,
        });
      }
      const layout = layouts.get(at);
      if (layout && layout.canvas.width > 0) {
        for (const finding of detectLayoutIssues(layout.canvas, layout.nodes, { frame: at, time })) pushFinding(finding);
      }
    }

    if (!sheets) {
      return {
        scene: stampOf(scene, id),
        images: result.data,
        cells: shots.map((frame) => [frame]),
        frames,
        findings,
        fps,
        mode: sweepMode,
      };
    }
    for (const [index, { timecode }] of result.data.entries()) {
      const at = shots[index]!;
      await sheets.add(index, { at, timecode, image: decoded.get(at)! });
    }
    const sheetImages = sheets.result();
    return {
      scene: stampOf(scene, id),
      images: sheetImages,
      cells: sheets.cells().map((indices) => indices.map((index) => shots[index]!)),
      frames,
      findings,
      fps,
      mode: sweepMode,
    };
  } finally {
    target.dispose();
  }
};
