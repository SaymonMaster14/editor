/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import {
  detectLayoutIssues,
  framePixelStats,
  INLINE_MAX_BYTES,
  INLINE_MAX_IMAGES,
  QaReceipt,
  qaDelivery,
  selectSweepPositions,
} from "./qa";

import type { QaLayoutNode } from "./qa";

describe("qaDelivery", () => {
  it("inlines few small images, paths otherwise", () => {
    expect(qaDelivery([100, 200])).toEqual(["inline", "inline"]);
    expect(qaDelivery([100, 200, 300, 400, 500])).toEqual(["path", "path", "path", "path", "path"]);
    expect(qaDelivery([100, INLINE_MAX_BYTES + 1])).toEqual(["path", "path"]);
    expect(qaDelivery([INLINE_MAX_BYTES])).toEqual(["inline"]);
    expect(INLINE_MAX_IMAGES).toBe(4);
  });
});

describe("selectSweepPositions", () => {
  const landmarks = [
    { frame: 10, reason: "clip-enter:a", priority: 10 },
    { frame: 50, reason: "text-enter:title", priority: 20 },
    { frame: 90, reason: "keyframe", priority: 5 },
  ];

  it("merges landmarks and regular coverage in frame order", () => {
    const positions = selectSweepPositions({ endFrame: 100, landmarks, regular: [25, 75], mode: "auto", maxFrames: 12 });
    expect(positions.map((p) => p.frame)).toEqual([0, 10, 25, 50, 75, 90, 100]);
    expect(positions[0]!.reasons).toContain("scene-start");
    expect(positions[positions.length - 1]!.reasons).toContain("scene-end");
  });

  it("dedupes reasons onto one position and clamps out-of-range frames", () => {
    const positions = selectSweepPositions({
      endFrame: 100,
      landmarks: [...landmarks, { frame: 50, reason: "gap-mid", priority: 8 }, { frame: 500, reason: "oops", priority: 1 }],
      regular: [],
      mode: "landmarks",
      maxFrames: 12,
    });
    const at50 = positions.find((p) => p.frame === 50)!;
    expect(at50.reasons).toEqual(expect.arrayContaining(["text-enter:title", "gap-mid"]));
    expect(positions.every((p) => p.frame >= 0 && p.frame <= 100)).toBe(true);
  });

  it("sheds low-priority positions past the cap", () => {
    const positions = selectSweepPositions({ endFrame: 100, landmarks, regular: [25, 75], mode: "auto", maxFrames: 3 });
    expect(positions).toHaveLength(3);
    // scene-start/end (priority 100) plus the top landmark survive.
    expect(positions.map((p) => p.frame)).toEqual([0, 50, 100]);
  });

  it("honors landmarks-only and regular-only modes", () => {
    const only = selectSweepPositions({ endFrame: 100, landmarks, regular: [25, 75], mode: "landmarks", maxFrames: 12 });
    expect(only.map((p) => p.frame)).toEqual([0, 10, 50, 90, 100]);
    const coverage = selectSweepPositions({ endFrame: 100, landmarks, regular: [25, 75], mode: "regular", maxFrames: 12 });
    expect(coverage.map((p) => p.frame)).toEqual([25, 75]);
  });
});

describe("framePixelStats", () => {
  function buffer(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = fill(x, y);
        const o = (y * width + x) * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  it("flags black and uniform frames, passes varied ones", () => {
    expect(framePixelStats(buffer(16, 16, () => [0, 0, 0]), 16, 16)).toMatchObject({ dark: true, uniform: true, luminance: 0 });
    expect(framePixelStats(buffer(16, 16, () => [200, 200, 200]), 16, 16)).toMatchObject({ dark: false, uniform: true });
    const varied = framePixelStats(buffer(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255])), 16, 16);
    expect(varied).toMatchObject({ dark: false, uniform: false });
    expect(varied.luminance).toBeGreaterThan(100);
  });

  it("handles degenerate input without throwing", () => {
    expect(framePixelStats(new Uint8Array(0), 0, 0)).toMatchObject({ dark: true, uniform: true });
    expect(framePixelStats(new Uint8Array(4), 16, 16)).toMatchObject({ dark: true, uniform: true });
  });
});

describe("detectLayoutIssues", () => {
  const canvas = { width: 1000, height: 1000 };
  const node = (over: Partial<QaLayoutNode> & { rect: QaLayoutNode["rect"] }): QaLayoutNode => ({ kind: "shape", ...over });

  it("finds offscreen, clipped, unsafe and stretched nodes", () => {
    const findings = detectLayoutIssues(
      canvas,
      [
        node({ kind: "text", stamp: "title", rect: { x: 1100, y: 100, width: 200, height: 60 } }),
        node({ kind: "shape", stamp: "edge", rect: { x: 900, y: 100, width: 200, height: 60 } }),
        node({ kind: "caption", stamp: "cap", rect: { x: 10, y: 10, width: 200, height: 60 } }),
        node({ kind: "video", stamp: "clip", rect: { x: 100, y: 100, width: 400, height: 300 }, scaleX: 1.5, scaleY: 1 }),
        node({ kind: "text", stamp: "ok", rect: { x: 100, y: 100, width: 200, height: 60 } }),
      ],
      { frame: 7, time: 0.25 },
    );
    expect(findings.map((f) => f.code)).toEqual(["offscreen", "clipped", "unsafe-area", "stretched"]);
    expect(findings[0]).toMatchObject({ node: "title", frame: 7, time: 0.25, severity: "warning" });
    expect(findings[3]!.message).toContain("clip");
  });

  it("finds overlapping text but ignores tiny touches and zero-size nodes", () => {
    const findings = detectLayoutIssues(canvas, [
      node({ kind: "text", stamp: "a", rect: { x: 100, y: 100, width: 200, height: 60 } }),
      node({ kind: "text", stamp: "b", rect: { x: 150, y: 120, width: 200, height: 60 } }),
      node({ kind: "text", stamp: "touch", rect: { x: 348, y: 120, width: 200, height: 60 } }),
      node({ kind: "text", stamp: "flat", rect: { x: 100, y: 100, width: 0, height: 0 } }),
    ]);
    const overlaps = findings.filter((f) => f.code === "text-overlap");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.message).toContain("a");
    expect(overlaps[0]!.message).toContain("b");
  });

  it("accepts uniform media scale and safe text", () => {
    expect(
      detectLayoutIssues(canvas, [
        node({ kind: "image", stamp: "pic", rect: { x: 100, y: 100, width: 400, height: 300 }, scaleX: 2, scaleY: 2 }),
        node({ kind: "text", stamp: "ok", rect: { x: 100, y: 100, width: 200, height: 60 } }),
      ]),
    ).toEqual([]);
  });
});

describe("QaReceipt", () => {
  it("parses a full sweep record", () => {
    const receipt = {
      version: 1,
      tool: "qa_sweep",
      scene: "Main",
      createdAt: new Date(0).toISOString(),
      fps: 30,
      mode: "auto",
      images: [
        { timecode: "00s00f-01s00f", path: "C:\\x\\sheet-1.png", sha256: "ab".repeat(32), bytes: 10, delivery: "inline", frames: [0, 30] },
      ],
      frames: [{ frame: 0, time: 0, timecode: "00s00f", reasons: ["scene-start"], luminance: 12.5, dark: false, uniform: false }],
      findings: [{ code: "clipped", severity: "warning", message: "edge is clipped", node: "edge", frame: 30, time: 1 }],
      stats: { frames: 2, images: 1, errors: 0, warnings: 1 },
    };
    expect(QaReceipt.parse(receipt)).toEqual(receipt);
  });
});
