/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { present, toCallToolResult } from "./present";
import type { QaReceipt } from "@diffusionstudio/dapi";

const dir = mkdtempSync(join(tmpdir(), "dapi-present-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const png = (byte: number, size = 8) => new Uint8Array(size).fill(byte);

describe("present", () => {
  it("writes capture frames by timecode into the requested directory and returns their paths", async () => {
    const out = join(dir, "frames");
    const presented = await present("capture", { id: "intro", output: out }, [
      { timecode: "0f", png: png(1) },
      { timecode: "1s", png: png(2) },
    ]);
    expect(presented.output).toEqual({ images: [{ timecode: "0f", path: join(out, "0f.png") }, { timecode: "1s", path: join(out, "1s.png") }] });
    expect(readFileSync(join(out, "1s.png"))).toEqual(Buffer.from(png(2)));
  });

  it("picks a fresh temp directory when none is given", async () => {
    const presented = await present("media_grab", { path: "/c.mp4" }, [{ timecode: "0f", png: png(3) }]);
    const { path } = (presented.output as { images: Array<{ path: string }> }).images[0]!;
    expect(path).toMatch(/dapi-grab-.*[\\/]0f\.png$/);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  it("writes effect sheets by timecode and keeps path, frames, and cached next to them", async () => {
    const out = join(dir, "effects");
    const presented = await present(
      "media_effects",
      { path: "/c.mp4", output: out },
      { path: "/c.mp4", images: [{ timecode: "0f-2s", png: png(9) }], frames: 3, cached: false },
    );
    expect(presented.output).toEqual({
      path: "/c.mp4",
      images: [{ timecode: "0f-2s", path: join(out, "0f-2s.png") }],
      frames: 3,
      cached: false,
    });
    expect(readFileSync(join(out, "0f-2s.png"))).toEqual(Buffer.from(png(9)));
  });

  it("keeps a preview's other fields next to the path", async () => {
    const file = join(dir, "wave.png");
    const presented = await present("media_waveform", { path: "/c.mp4", output: file }, { png: png(4), silences: [{ start: 0, end: 1 }] });
    expect(presented.output).toEqual({ path: file, silences: [{ start: 0, end: 1 }] });
  });

  it("writes a preview or transcript into an output that names an existing directory", async () => {
    const out = join(dir, "into");
    mkdirSync(out, { recursive: true });
    const preview = await present("media_waveform", { path: "/c.mp4", output: out }, { png: png(7), silences: [] });
    const previewPath = (preview.output as { path: string }).path;
    expect(dirname(previewPath)).toBe(out);
    expect(basename(previewPath)).toMatch(/^dapi-waveform-.*\.png$/);
    expect(readFileSync(previewPath)).toEqual(Buffer.from(png(7)));

    const transcript = await present("media_transcribe", { path: "/c.mp4", output: out }, { segments: [] });
    const transcriptPath = (transcript.output as { path: string }).path;
    expect(transcriptPath).toMatch(/dapi-transcript-.*\.json$/);
    expect(JSON.parse(readFileSync(transcriptPath, "utf8"))).toEqual({ segments: [] });
  });

  it("names screenshots by time and never overwrites one", async () => {
    const first = await present("screenshot", { output: dir }, { png: png(5), width: 10, height: 10 });
    const second = await present("screenshot", { output: dir }, { png: png(6), width: 10, height: 10 });
    const a = (first.output as { path: string }).path;
    const b = (second.output as { path: string }).path;
    expect(a).toMatch(/diffusion-studio_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/);
    expect(b).not.toBe(a);
  });

  it("writes a transcript to a file, unchanged, and returns its path and size", async () => {
    const file = join(dir, "talk.json");
    const segments = [{ text: "Hi there", words: [{ text: "Hi", start: 0, end: 0.2 }, { text: "there", start: 0.3, end: 0.6 }] }];
    const presented = await present("media_transcribe", { path: "/c.mp4", output: file }, { segments });
    expect(presented).toEqual({ output: { path: file, segments: 1, words: 2 }, images: [] });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ segments });
  });

  it("writes sweep images plus a hashed receipt with delivery evidence", async () => {
    const out = join(dir, "qa");
    const result = {
      scene: "Main",
      images: [
        { timecode: "00s00f", png: png(1) },
        { timecode: "01s00f", png: png(2) },
      ],
      cells: [[0], [30]],
      frames: [
        { frame: 0, time: 0, timecode: "00s00f", reasons: ["scene-start"], luminance: 10, dark: false, uniform: false },
        { frame: 30, time: 1, timecode: "01s00f", reasons: ["regular"], luminance: 0, dark: true, uniform: true },
      ],
      findings: [{ code: "rendered-black", severity: "warning", message: "frame renders black at 01s00f", frame: 30, time: 1 }],
      fps: 30,
      mode: "auto",
    };
    const presented = await present("qa_sweep", { id: "Main", output: out }, result);
    const output = presented.output as { images: Array<{ path: string }>; receipt: { path: string; receipt: QaReceipt } };
    expect(output.images).toHaveLength(2);
    expect(readFileSync(output.images[0]!.path)).toEqual(Buffer.from(png(1)));
    const onDisk = JSON.parse(readFileSync(output.receipt.path, "utf8"));
    expect(onDisk).toEqual(output.receipt.receipt);
    expect(onDisk.tool).toBe("qa_sweep");
    expect(onDisk.images[0]).toMatchObject({ bytes: 8, delivery: "inline", frames: [0] });
    expect(onDisk.images[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk.stats).toEqual({ frames: 2, images: 2, errors: 0, warnings: 1 });
    const again = await present("qa_sweep", { id: "Main", output: out }, result);
    expect((again.output as { receipt: { path: string } }).receipt.path).toBe(join(out, "qa-receipt-2.json"));
  });

  it("writes a segmentation overlay plus one mask file per detection", async () => {
    const out = join(dir, "segment");
    const presented = await present(
      "media_segment",
      { path: "/c.mp4", output: out },
      {
        path: "/c.mp4",
        time: 1,
        width: 8,
        height: 4,
        engine: "yolo11n-seg",
        device: "cuda:0",
        ms: 12,
        detections: [
          { cls: "person", cls_id: 0, conf: 0.9, bbox: [0, 0, 4, 4], area: 10, mask: png(11) },
          { cls: "Bed Room!", cls_id: 59, conf: 0.5, bbox: [4, 0, 8, 4], area: 5, mask: png(12) },
        ],
        overlay: png(13),
        cached: false,
      },
    );
    expect(presented.output).toEqual({
      path: "/c.mp4",
      time: 1,
      width: 8,
      height: 4,
      engine: "yolo11n-seg",
      device: "cuda:0",
      ms: 12,
      detections: [
        { cls: "person", cls_id: 0, conf: 0.9, bbox: [0, 0, 4, 4], area: 10, mask: join(out, "mask-person-0.png") },
        { cls: "Bed Room!", cls_id: 59, conf: 0.5, bbox: [4, 0, 8, 4], area: 5, mask: join(out, "mask-bed-room--1.png") },
      ],
      overlay: join(out, "overlay.png"),
      cached: false,
    });
    expect(readFileSync(join(out, "overlay.png"))).toEqual(Buffer.from(png(13)));
    expect(readFileSync(join(out, "mask-person-0.png"))).toEqual(Buffer.from(png(11)));
    expect(presented.images).toEqual([{ path: join(out, "overlay.png"), png: png(13) }]);
  });

  it("passes other results through untouched", async () => {
    expect(await present("check", { id: "x" }, { stats: {}, issues: [] })).toEqual({ output: { stats: {}, issues: [] }, images: [] });
  });
});

describe("toCallToolResult", () => {
  it("inlines a few small images and always carries the output as text and structure", () => {
    const result = toCallToolResult({ output: { images: [] }, images: [{ path: "/a.png", png: png(1) }] });
    expect(result.structuredContent).toEqual({ images: [] });
    expect(result.content[0]).toEqual({ type: "text", text: '{"images":[]}' });
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("sends paths only when there are many images or a large one", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `/${i}.png`, png: png(i) }));
    expect(toCallToolResult({ output: {}, images: many }).content).toHaveLength(1);
    const large = [{ path: "/big.png", png: png(0, (1 << 20) + 1) }];
    expect(toCallToolResult({ output: {}, images: large }).content).toHaveLength(1);
  });
});
