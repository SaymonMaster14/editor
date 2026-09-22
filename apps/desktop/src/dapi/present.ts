/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { QaReceipt, TimecodedImage, ToolArgs, ToolName, ToolOutput, ToolResult } from "@diffusionstudio/dapi";
import { qaDelivery } from "@diffusionstudio/dapi";

/** A file the tool wrote, kept in memory only long enough to decide whether to inline it. */
export type WrittenImage = { path: string; png: Uint8Array };

export type Presented = { output: unknown; images: WrittenImage[] };

const APP_SLUG = "diffusion-studio";

export async function present(name: ToolName, args: unknown, result: unknown): Promise<Presented> {
  switch (name) {
    case "capture":
      return presentImages(result as ToolResult<"capture">, (args as ToolArgs<"capture">).output, "capture");
    case "qa_sweep":
      return presentQaSweep(result as ToolResult<"qa_sweep">, (args as ToolArgs<"qa_sweep">).output);
    case "media_grab":
      return presentImages(result as ToolResult<"media_grab">, (args as ToolArgs<"media_grab">).output, "grab");
    case "media_effects":
      return presentEffects(result as ToolResult<"media_effects">, (args as ToolArgs<"media_effects">).output);
    case "media_segment":
      return presentSegment(result as ToolResult<"media_segment">, (args as ToolArgs<"media_segment">).output);
    case "media_filmstrip":
      return presentPreview(result as ToolResult<"media_filmstrip">, (args as ToolArgs<"media_filmstrip">).output, "filmstrip");
    case "media_waveform":
      return presentPreview(result as ToolResult<"media_waveform">, (args as ToolArgs<"media_waveform">).output, "waveform");
    case "screenshot":
      return presentScreenshot(result as ToolResult<"screenshot">, (args as ToolArgs<"screenshot">).output);
    case "media_transcribe":
      return presentTranscript(result as ToolResult<"media_transcribe">, (args as ToolArgs<"media_transcribe">).output);
    default:
      return { output: result, images: [] };
  }
}

/**
 * A sweep lands as images plus its QA receipt: the PNGs by timecode, then
 * `qa-receipt.json` with every sampled frame, its sha256, which images rode
 * inline (the caller saw those pixels) versus path-only, and the findings.
 * Repeat sweeps to one directory keep every receipt, numbered in order, so
 * iterations compare by hash.
 */
async function presentQaSweep(result: ToolResult<"qa_sweep">, output: string | undefined): Promise<Presented> {
  const dir = output ?? (await mkdtemp(join(tmpdir(), "dapi-qa-")));
  await mkdir(dir, { recursive: true });
  const written: WrittenImage[] = [];
  const refs: ToolOutput<"qa_sweep">["images"] = [];
  for (const { timecode, png } of result.images) {
    const path = join(dir, `${timecode}.png`);
    await writeFile(path, png);
    written.push({ path, png });
    refs.push({ timecode, path });
  }
  const delivery = qaDelivery(result.images.map((image) => image.png.byteLength));
  const receipt: QaReceipt = {
    version: 1,
    tool: "qa_sweep",
    scene: result.scene,
    createdAt: new Date().toISOString(),
    fps: result.fps,
    mode: result.mode,
    images: result.images.map((image, index) => ({
      timecode: image.timecode,
      path: refs[index]!.path,
      sha256: createHash("sha256").update(image.png).digest("hex"),
      bytes: image.png.byteLength,
      delivery: delivery[index]!,
      frames: result.cells[index] ?? [],
    })),
    frames: result.frames,
    findings: result.findings,
    stats: {
      frames: result.frames.length,
      images: result.images.length,
      errors: result.findings.filter((finding) => finding.severity === "error").length,
      warnings: result.findings.filter((finding) => finding.severity === "warning").length,
    },
  };
  let attempt = 1;
  let receiptPath = join(dir, "qa-receipt.json");
  while (existsSync(receiptPath)) receiptPath = join(dir, `qa-receipt-${++attempt}.json`);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  const presented: ToolOutput<"qa_sweep"> = { images: refs, receipt: { path: receiptPath, receipt } };
  return { output: presented, images: written };
}

// Frames and contact sheets arrive in the same shape: each image is stamped
// with its timecode (`08s10f`, or `0f-08s10f` for a sheet), which is the
// filename too.
async function presentImages(images: TimecodedImage[], output: string | undefined, kind: string): Promise<Presented> {
  const dir = output ?? (await mkdtemp(join(tmpdir(), `dapi-${kind}-`)));
  await mkdir(dir, { recursive: true });
  const written: WrittenImage[] = [];
  const refs: ToolOutput<"capture">["images"] = [];
  for (const { timecode, png } of images) {
    const path = join(dir, `${timecode}.png`);
    await writeFile(path, png);
    written.push({ path, png });
    refs.push({ timecode, path });
  }
  return { output: { images: refs }, images: written };
}

/**
 * Where a single-file tool writes: `output` when given, a fresh name under
 * the temp dir otherwise. An `output` that names an existing directory gets
 * the fresh name inside it rather than an EISDIR from writeFile.
 */
async function singleFilePath(output: string | undefined, name: string): Promise<string> {
  if (output === undefined) return join(tmpdir(), name);
  const existing = await stat(output).catch(() => null);
  if (existing?.isDirectory()) return join(output, name);
  await mkdir(dirname(output), { recursive: true });
  return output;
}

/**
 * Effect sheets land like grabs — one PNG per sheet by timecode — plus
 * the render's path, frame count, and whether the cache served it.
 */
async function presentEffects(result: ToolResult<"media_effects">, output: string | undefined): Promise<Presented> {
  const dir = output ?? (await mkdtemp(join(tmpdir(), "dapi-effects-")));
  await mkdir(dir, { recursive: true });
  const written: WrittenImage[] = [];
  const refs: ToolOutput<"media_effects">["images"] = [];
  for (const { timecode, png } of result.images) {
    const path = join(dir, `${timecode}.png`);
    await writeFile(path, png);
    written.push({ path, png });
    refs.push({ timecode, path });
  }
  const presented: ToolOutput<"media_effects"> = {
    path: result.path,
    images: refs,
    frames: result.frames,
    cached: result.cached,
  };
  return { output: presented, images: written };
}

/**
 * Segmentation lands as the overlay plus one mask PNG per detection:
 * `overlay.png` for eyeballing, `mask-<cls>-<i>.png` for compositing
 * (background blur, text-behind-subject). The overlay rides inline when
 * small; the masks are path-only — the agent composites from the files.
 */
async function presentSegment(result: ToolResult<"media_segment">, output: string | undefined): Promise<Presented> {
  const dir = output ?? (await mkdtemp(join(tmpdir(), "dapi-segment-")));
  await mkdir(dir, { recursive: true });
  const overlayPath = join(dir, "overlay.png");
  await writeFile(overlayPath, result.overlay);
  const refs: ToolOutput<"media_segment">["detections"] = [];
  for (let i = 0; i < result.detections.length; i++) {
    const det = result.detections[i]!;
    const safe = det.cls.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const maskPath = join(dir, `mask-${safe}-${i}.png`);
    await writeFile(maskPath, det.mask);
    const { mask: _mask, ...rest } = det;
    refs.push({ ...rest, mask: maskPath });
  }
  const presented: ToolOutput<"media_segment"> = {
    path: result.path,
    time: result.time,
    width: result.width,
    height: result.height,
    engine: result.engine,
    device: result.device,
    ms: result.ms,
    detections: refs,
    overlay: overlayPath,
    cached: result.cached,
  };
  return { output: presented, images: [{ path: overlayPath, png: result.overlay }] };
}

async function presentPreview(
  result: { png: Uint8Array } & Record<string, unknown>,
  output: string | undefined,
  kind: string,
): Promise<Presented> {
  const { png, ...rest } = result;
  const path = await singleFilePath(output, `dapi-${kind}-${randomUUID()}.png`);
  await writeFile(path, png);
  return { output: { path, ...rest }, images: [{ path, png }] };
}

async function presentScreenshot(result: ToolResult<"screenshot">, output: string | undefined): Promise<Presented> {
  const dir = output ?? tmpdir();
  await mkdir(dir, { recursive: true });
  const taken = new Date();
  let attempt = 1;
  let path = join(dir, screenshotFilename(taken, attempt));
  while (existsSync(path)) path = join(dir, screenshotFilename(taken, ++attempt));
  await writeFile(path, result.png);
  const presented: ToolOutput<"screenshot"> = { path, width: result.width, height: result.height };
  return { output: presented, images: [{ path, png: result.png }] };
}

async function presentTranscript(transcript: ToolResult<"media_transcribe">, output: string | undefined): Promise<Presented> {
  const path = await singleFilePath(output, `dapi-transcript-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(transcript, null, 2));
  const words = transcript.segments.reduce((sum, segment) => sum + segment.words.length, 0);
  const presented: ToolOutput<"media_transcribe"> = { path, segments: transcript.segments.length, words };
  return { output: presented, images: [] };
}

function screenshotFilename(taken: Date, attempt: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [taken.getFullYear(), pad(taken.getMonth() + 1), pad(taken.getDate())].join("-");
  const time = [pad(taken.getHours()), pad(taken.getMinutes()), pad(taken.getSeconds())].join("-");
  return `${APP_SLUG}_${date}_${time}${attempt > 1 ? `-${attempt}` : ""}.png`;
}

/** The MCP result: the output as text and structured content, plus the images when they are few and small. */
export function toCallToolResult({ output, images }: Presented): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(output) }];
  const [delivery] = qaDelivery(images.map((image) => image.png.byteLength));
  const inline = delivery === "inline" || images.length === 0;
  if (inline) {
    for (const { png } of images) {
      content.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
    }
  }
  return { content, structuredContent: output as Record<string, unknown> };
}

/** A failure the agent reads as a sentence, not a protocol error. */
export function toErrorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
}
