/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { formatTimecode, getAssetFile } from "@diffusionstudio/runtime";
import { applyEffects } from "@diffusionstudio/effects";
import { encodePng } from "@diffusionstudio/encoder";
import { DapiError } from "@diffusionstudio/dapi";
import { requireAssetType, resolveAsset } from "../lib/assets";
import { analyzeCached, mediaStore } from "../lib/analysis-cache";
import { SheetCollector } from "../lib/sheets";

import type { FrameQuality, TimecodedImage, ToolArgs } from "@diffusionstudio/dapi";
import type { ToolHandler } from "../handler";

// Named quality presets mapped to a per-frame total-pixel budget (aspect ratio
// preserved). A budget of 0 means native resolution. Previews default to
// medium: cheaper to render than grab's fullres default, plenty for judging a look.
const FRAME_QUALITY_BUDGETS: Record<FrameQuality, number> = {
  small: 384 * 384,
  medium: 768 * 768,
  large: 1536 * 1536,
  fullres: 0,
};

export const mediaEffects: ToolHandler<"media_effects"> = async (args, ctx) => {
  const { effects, times, count, start, end, quality, separate, perSheet } = args;
  const asset = await resolveAsset(ctx, args.path);
  requireAssetType(asset, ["VIDEO"], "preview effects on");
  if (asset.duration === undefined || asset.duration <= 0) {
    throw new DapiError("invalid-input", `Asset ${asset.id} reports no usable duration.`);
  }

  // `count` samples evenly across a window (default the whole clip);
  // otherwise render the explicit `times` (one frame at 0 by default).
  const from = Math.min(Math.max(start ?? 0, 0), asset.duration);
  const to = Math.min(Math.max(end ?? asset.duration, from), asset.duration);
  let requested: number[];
  if (count !== undefined) {
    if (to <= from) {
      throw new DapiError(
        "invalid-input",
        `The requested window is empty; start (${from.toFixed(2)}s) is at or past end (${to.toFixed(2)}s).`,
      );
    }
    const interval = (to - from) / count;
    requested = Array.from({ length: count }, (_, i) => from + i * interval);
  } else {
    requested = (times && times.length ? times : [0]).map((t) => resolveTime(t, asset.duration));
  }

  const budget = FRAME_QUALITY_BUDGETS[quality ?? "medium"];
  const blob = await getAssetFile(asset);
  const { result, cached } = await analyzeCached({
    kind: "media_effects",
    engine: "diffusion-effects",
    engineVersion: "1",
    source: blob,
    params: { effects, times, count, start, end, quality, separate, perSheet },
    duration: asset.duration,
    cache: mediaStore,
    run: async () => {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new DapiError("wrong-kind", `Asset ${asset.id} has no video track.`);

        // Track timestamps may not start at 0; offset content time by the first.
        const firstTimestamp = (await track.getFirstTimestamp()) ?? 0;

        // Downscale to fit the pixel budget while preserving aspect ratio.
        const displayWidth = await track.getDisplayWidth();
        const displayHeight = await track.getDisplayHeight();
        let sourceWidth = displayWidth;
        let sourceHeight = displayHeight;
        if (budget > 0 && displayWidth * displayHeight > budget) {
          const scale = Math.sqrt(budget / (displayWidth * displayHeight));
          sourceWidth = Math.max(1, Math.round(displayWidth * scale));
          sourceHeight = Math.max(1, Math.round(displayHeight * scale));
        }

        // Lay the sheets out up front: the largest cell across them sets the
        // decode size, so no frame is decoded bigger than it will be drawn.
        const sheets = separate ? undefined : new SheetCollector(requested.length, { width: sourceWidth, height: sourceHeight }, perSheet);
        const width = sheets ? Math.min(sourceWidth, sheets.cellWidth) : sourceWidth;

        // Decode in ascending order (the sink's fast path), remember each
        // entry's original slot so output mirrors the requested order.
        const ordered = requested.map((time, index) => ({ time, index })).sort((a, b) => a.time - b.time);

        const sink = new CanvasSink(track, width < displayWidth ? { width } : undefined);
        const frames: TimecodedImage[] = new Array(requested.length);

        let i = 0;
        for await (const wrapped of sink.canvasesAtTimestamps(ordered.map(({ time }) => firstTimestamp + time))) {
          const { time, index } = ordered[i++]!;
          if (!wrapped) throw new DapiError("not-found", `No frame found at ${time}s.`);
          const timecode = formatTimecode(time, asset.frameRate);
          const effected = effectCanvas(wrapped.canvas, time, effects);
          if (sheets) await sheets.add(index, { at: time, timecode, image: effected });
          else frames[index] = { timecode, png: await encodePng(effected) };
        }
        return { path: asset.path, images: sheets ? sheets.result() : frames, frames: requested.length };
      } finally {
        input.dispose();
      }
    },
  });
  return { ...result, cached };
};

/** Decodes one canvas to RGB, runs the stack, and returns the effected canvas. */
function effectCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, time: number, effects: ToolArgs<"media_effects">["effects"]): HTMLCanvasElement {
  const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx2d || !("getImageData" in ctx2d)) {
    throw new DapiError("unsupported", "Effect previews need a 2D canvas context, which is unavailable.");
  }
  const pixels = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    rgb[j] = pixels[i]!;
    rgb[j + 1] = pixels[i + 1]!;
    rgb[j + 2] = pixels[i + 2]!;
  }
  let effected;
  try {
    effected = applyEffects({ data: rgb, width: canvas.width, height: canvas.height, time }, effects);
  } catch (error) {
    throw new DapiError("invalid-input", error instanceof Error ? error.message : String(error));
  }
  const out = document.createElement("canvas");
  out.width = effected.width;
  out.height = effected.height;
  const outCtx = out.getContext("2d");
  if (!outCtx) throw new DapiError("unsupported", "Effect previews need a 2D canvas context, which is unavailable.");
  const rgba = new ImageData(effected.width, effected.height);
  for (let i = 0, j = 0; i < effected.data.length; i += 3, j += 4) {
    rgba.data[j] = effected.data[i]!;
    rgba.data[j + 1] = effected.data[i + 1]!;
    rgba.data[j + 2] = effected.data[i + 2]!;
    rgba.data[j + 3] = 255;
  }
  outCtx.putImageData(rgba, 0, 0);
  return out;
}

/**
 * A time within the clip. A negative time is an offset back from the end:
 * -1 is one second before the end, -1f one frame before it.
 */
function resolveTime(t: number, duration: number): number {
  if (t >= 0) {
    if (t > duration) {
      throw new DapiError("invalid-input", `time ${t}s is past the asset's duration (${duration.toFixed(2)}s).`);
    }
    return t;
  }
  const resolved = duration + t;
  if (resolved < 0) {
    throw new DapiError("invalid-input", `time ${t} counts past the start of the clip (duration ${duration.toFixed(2)}s).`);
  }
  return resolved;
}
