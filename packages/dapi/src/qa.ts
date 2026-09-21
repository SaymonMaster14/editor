/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The pure core of the visual QA sweep: position selection, pixel stats,
// layout detectors, the delivery rule, and the receipt schema. No world, no
// DOM, no fs — the renderer handler feeds it snapshots and the main process
// writes the receipt, so everything here runs under plain node tests.

import { z } from "zod";

// -------------------------------------------------------------------
// Delivery: did the pixels reach the model?
//
// The MCP server inlines result images into the tool result when they are
// few and small, and hands back paths otherwise. Both the receipt writer
// and the presenter apply this one rule, so the receipt's `delivery` field
// is the evidence of which frames' pixels rode along inline.
/** More than this, or any image larger than INLINE_MAX_BYTES, and the caller gets paths only. */
export const INLINE_MAX_IMAGES = 4;
export const INLINE_MAX_BYTES = 1 << 20;

export type QaDelivery = "inline" | "path";

/** The delivery of each image, in order: `inline` only when every image qualifies. */
export function qaDelivery(imageBytes: number[]): QaDelivery[] {
  const inline = imageBytes.length <= INLINE_MAX_IMAGES && imageBytes.every((bytes) => bytes <= INLINE_MAX_BYTES);
  return imageBytes.map(() => (inline ? "inline" : "path"));
}

// -------------------------------------------------------------------
// Position selection

export const QaSweepMode = z.enum(["auto", "landmarks", "regular"]);
export type QaSweepMode = z.output<typeof QaSweepMode>;

/** One candidate sample: the frame on the capture clock, why it was picked, and its priority. */
export type QaLandmark = {
  frame: number;
  /** e.g. `scene-start`, `clip-enter:hero`, `text-enter:title`, `keyframe`, `gap-mid`, `regular`. */
  reason: string;
  /** Higher survives the cap first. */
  priority: number;
};

export type QaPosition = {
  frame: number;
  reasons: string[];
};

export function selectSweepPositions(options: {
  /** Last frame on the capture clock, inclusive. */
  endFrame: number;
  landmarks: QaLandmark[];
  /** Evenly spaced frames across [0, endFrame]; the handler adds these in `auto`/`regular` modes. */
  regular: number[];
  mode: QaSweepMode;
  maxFrames: number;
}): QaPosition[] {
  const { endFrame, mode } = options;
  const clamp = (frame: number): number => Math.max(0, Math.min(endFrame, Math.round(frame)));
  const byFrame = new Map<number, { reasons: string[]; priority: number }>();
  const add = (frame: number, reason: string, priority: number): void => {
    const at = clamp(frame);
    const entry = byFrame.get(at);
    if (!entry) {
      byFrame.set(at, { reasons: [reason], priority });
      return;
    }
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    if (priority > entry.priority) entry.priority = priority;
  };
  if (mode !== "regular") for (const landmark of options.landmarks) add(landmark.frame, landmark.reason, landmark.priority);
  if (mode !== "landmarks") for (const frame of options.regular) add(frame, "regular", 0);
  // Frame 0 always: the first thing an export encodes. The last frame too,
  // so an animation ending offscreen has nowhere to hide.
  if (mode !== "regular") {
    add(0, "scene-start", 100);
    add(endFrame, "scene-end", 100);
  }
  const sorted = [...byFrame.entries()].sort((a, b) => b[1].priority - a[1].priority || a[0] - b[0]);
  const kept = sorted.slice(0, Math.max(1, options.maxFrames));
  kept.sort((a, b) => a[0] - b[0]);
  return kept.map(([frame, entry]) => ({ frame, reasons: entry.reasons }));
}

// -------------------------------------------------------------------
// Pixel stats

export type QaPixelStats = {
  /** Mean Rec.601 luma over the sampled pixels, 0-255. */
  luminance: number;
  /** Effectively black: nothing visible survived the encode. */
  dark: boolean;
  /** Effectively one flat color: empty canvas, frozen decoder, solid bug. */
  uniform: boolean;
};

/** At most this many pixels feed the stats; a 4K frame samples every ~40th. */
const STATS_MAX_SAMPLES = 200_000;

export function framePixelStats(rgba: Uint8Array, width: number, height: number): QaPixelStats {
  const pixels = width * height;
  if (pixels <= 0 || rgba.length < pixels * 4) return { luminance: 0, dark: true, uniform: true };
  const stride = Math.max(1, Math.floor(pixels / STATS_MAX_SAMPLES));
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < pixels; i += stride) {
    const o = i * 4;
    const luma = 0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!;
    sum += luma;
    sumSq += luma * luma;
    count += 1;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }
  const luminance = count === 0 ? 0 : Math.round((sum / count) * 10) / 10;
  const variance = count === 0 ? 0 : sumSq / count - (sum / count) * (sum / count);
  return {
    luminance,
    dark: luminance <= 5 && max <= 24,
    uniform: max - min <= 8 && variance <= 4,
  };
}

// -------------------------------------------------------------------
// Layout detectors

/** One visual leaf's world-space box at a sampled frame, as the handler snapshots it. */
export type QaLayoutNode = {
  /** Source stamp of the node, when it has one. */
  stamp?: string;
  /** The check handler's kind vocabulary: text, caption, video, image, shape, ... */
  kind: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Local scale; non-uniform scale on media is the stretch signal. */
  scaleX?: number;
  scaleY?: number;
};

export const QaFindingCode = z.enum([
  "offscreen",
  "clipped",
  "unsafe-area",
  "text-overlap",
  "stretched",
  "rendered-black",
  "rendered-uniform",
]);
export type QaFindingCode = z.output<typeof QaFindingCode>;

export const QaFinding = z.object({
  code: QaFindingCode,
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  node: z.string().optional().describe("source stamp of the offending node; absent for frame-wide findings"),
  frame: z.number().int().optional().describe("frame on the capture clock the finding was seen at"),
  time: z.number().optional().describe("seconds on the capture clock the finding was seen at"),
});
export type QaFinding = z.output<typeof QaFinding>;

/** Text and captions live inside the 90% safe area; anything else may bleed. */
const SAFE_MARGIN = 0.05;
/** Past this the media's own aspect is visibly bent. */
const STRETCH_TOLERANCE = 0.05;
/** Overlaps smaller than this (each way) are kerning, not collisions. */
const OVERLAP_MIN = 4;

function intersects(a: QaLayoutNode["rect"], b: QaLayoutNode["rect"]): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function overlapSize(a: QaLayoutNode["rect"], b: QaLayoutNode["rect"]): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

export function detectLayoutIssues(
  canvas: { width: number; height: number },
  nodes: QaLayoutNode[],
  at?: { frame?: number; time?: number },
): QaFinding[] {
  const findings: QaFinding[] = [];
  const atFields = { ...(at?.frame !== undefined ? { frame: at.frame } : {}), ...(at?.time !== undefined ? { time: at.time } : {}) };
  const safe = {
    x: canvas.width * SAFE_MARGIN,
    y: canvas.height * SAFE_MARGIN,
    width: canvas.width * (1 - 2 * SAFE_MARGIN),
    height: canvas.height * (1 - 2 * SAFE_MARGIN),
  };
  const textish = (kind: string): boolean => kind === "text" || kind === "caption";

  for (const node of nodes) {
    const { rect } = node;
    if (!(rect.width > 0 && rect.height > 0)) continue;
    const label = node.stamp ?? node.kind;
    const outside =
      rect.x + rect.width <= 0 || rect.y + rect.height <= 0 || rect.x >= canvas.width || rect.y >= canvas.height;
    if (outside) {
      findings.push({
        code: "offscreen",
        severity: "warning",
        message: `${label} is fully outside the frame (${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)})`,
        ...(node.stamp ? { node: node.stamp } : {}),
        ...atFields,
      });
      continue;
    }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > canvas.width || rect.y + rect.height > canvas.height) {
      findings.push({
        code: "clipped",
        severity: "warning",
        message: `${label} is clipped by the frame edge (${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)} on ${canvas.width}x${canvas.height})`,
        ...(node.stamp ? { node: node.stamp } : {}),
        ...atFields,
      });
    }
    if (textish(node.kind) && !intersects(safe, rect)) {
      findings.push({
        code: "unsafe-area",
        severity: "warning",
        message: `${label} sits fully outside the 90% safe area`,
        ...(node.stamp ? { node: node.stamp } : {}),
        ...atFields,
      });
    } else if (
      textish(node.kind) &&
      (rect.x < safe.x || rect.y < safe.y || rect.x + rect.width > safe.x + safe.width || rect.y + rect.height > safe.y + safe.height)
    ) {
      findings.push({
        code: "unsafe-area",
        severity: "warning",
        message: `${label} crosses the 90% safe area edge`,
        ...(node.stamp ? { node: node.stamp } : {}),
        ...atFields,
      });
    }
    if ((node.kind === "video" || node.kind === "image") && node.scaleX !== undefined && node.scaleY !== undefined) {
      const sx = Math.abs(node.scaleX);
      const sy = Math.abs(node.scaleY);
      if (sx > 0 && sy > 0) {
        const ratio = sx > sy ? sx / sy : sy / sx;
        if (ratio - 1 > STRETCH_TOLERANCE) {
          findings.push({
            code: "stretched",
            severity: "warning",
            message: `${label} is scaled non-uniformly (${node.scaleX.toFixed(2)} x ${node.scaleY.toFixed(2)}) — the media's aspect is bent`,
            ...(node.stamp ? { node: node.stamp } : {}),
            ...atFields,
          });
        }
      }
    }
  }

  const labels = nodes.filter((node) => textish(node.kind) && node.rect.width > 0 && node.rect.height > 0);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!;
      const b = labels[j]!;
      if (!intersects(a.rect, b.rect)) continue;
      const { w, h } = overlapSize(a.rect, b.rect);
      if (w < OVERLAP_MIN || h < OVERLAP_MIN) continue;
      const [first, second] = [a.stamp ?? a.kind, b.stamp ?? b.kind].sort();
      findings.push({
        code: "text-overlap",
        severity: "warning",
        message: `text overlaps text: ${first} covers ${second} (${Math.round(w)}x${Math.round(h)})`,
        ...(a.stamp ? { node: a.stamp } : {}),
        ...atFields,
      });
    }
  }
  return findings;
}

// -------------------------------------------------------------------
// Receipt

/** One sampled frame as the handler analyzed it; the server adds path, hash and delivery. */
export const QaFrameAnalysis = z.object({
  frame: z.number().int().describe("frame on the capture clock"),
  time: z.number().describe("seconds on the capture clock"),
  timecode: z.string(),
  reasons: z.array(z.string()).describe("why this frame was sampled"),
  luminance: z.number(),
  dark: z.boolean(),
  uniform: z.boolean(),
});
export type QaFrameAnalysis = z.output<typeof QaFrameAnalysis>;

/** One written image: a contact sheet or, with separate, one frame. */
export const QaReceiptImage = z.object({
  timecode: z.string(),
  path: z.string().describe("absolute path of the PNG"),
  sha256: z.string().describe("hex sha256 of the PNG bytes"),
  bytes: z.number().int(),
  delivery: z.enum(["inline", "path"]).describe("inline: the pixels rode in the tool result; path: the caller got the path only"),
  frames: z.array(z.number().int()).describe("capture-clock frames this image shows, in cell order"),
});
export type QaReceiptImage = z.output<typeof QaReceiptImage>;

export const QaReceipt = z.object({
  version: z.literal(1),
  tool: z.literal("qa_sweep"),
  scene: z.string(),
  createdAt: z.string().describe("ISO timestamp of the sweep"),
  fps: z.number(),
  mode: QaSweepMode,
  images: z.array(QaReceiptImage),
  frames: z.array(QaFrameAnalysis),
  findings: z.array(QaFinding),
  stats: z.object({
    frames: z.number().int(),
    images: z.number().int(),
    errors: z.number().int(),
    warnings: z.number().int(),
  }),
});
export type QaReceipt = z.output<typeof QaReceipt>;

/** The receipt as the agent receives it: where it landed, plus the whole record inline. */
export const QaReceiptRef = z.object({
  path: z.string().describe("absolute path of the receipt JSON"),
  receipt: QaReceipt,
});
export type QaReceiptRef = z.output<typeof QaReceiptRef>;
