/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { encodePng } from "@diffusionstudio/encoder";
import { getAssetFile } from "@diffusionstudio/runtime";
import { DapiError, SEGMENT_ENGINE, SEGMENT_ENGINE_VERSION, SEGMENT_MAX_WIDTH } from "@diffusionstudio/dapi";
import { mainBridge } from "@/lib/ipc";
import { analyzeCached, mediaStore } from "../lib/analysis-cache";
import { requireAssetType, resolveAsset } from "../lib/assets";
import { decodeCappedFrame } from "../lib/capped-frame";

import type { SegmentWorkerResult } from "@diffusionstudio/dapi";
import type { ToolHandler } from "../handler";

/** Overlay tint per detection, cycled: red, cyan, lime, amber, violet. */
const TINTS: Array<[number, number, number]> = [
  [255, 64, 64],
  [64, 224, 255],
  [128, 255, 64],
  [255, 192, 64],
  [192, 128, 255],
];

export const mediaSegment: ToolHandler<"media_segment"> = async ({ path, time, classes, conf }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["VIDEO", "IMAGE"], "a video or image");
  const at = time ?? 0;
  const duration = asset.type === "VIDEO" ? asset.duration : undefined;
  if (duration !== undefined && at > duration) {
    throw new DapiError("invalid-input", `time ${at}s is past the asset's duration (${duration.toFixed(2)}s).`);
  }

  const blob = await getAssetFile(asset);
  const { result, cached } = await analyzeCached({
    kind: "media_segment",
    engine: SEGMENT_ENGINE,
    engineVersion: SEGMENT_ENGINE_VERSION,
    source: blob,
    params: { time: at, classes, conf },
    ...(duration !== undefined ? { duration } : {}),
    cache: mediaStore,
    run: async () => {
      const frame = await decodeCappedFrame(asset.type, blob, at, SEGMENT_MAX_WIDTH);
      let seg: SegmentWorkerResult;
      try {
        seg = await mainBridge.call(MAIN_CHANNELS.SEGMENT_RUN, {
          png: frame.png,
          ...(classes !== undefined ? { classes } : {}),
          ...(conf !== undefined ? { conf } : {}),
        });
      } catch (error) {
        throw segmentError(error);
      }
      const overlay = await compositeOverlay(frame.canvas, seg);
      return {
        path: asset.path,
        time: asset.type === "VIDEO" ? at : 0,
        width: frame.canvas.width,
        height: frame.canvas.height,
        engine: SEGMENT_ENGINE,
        device: seg.device,
        ms: seg.ms,
        detections: seg.detections.map((det) => ({ ...det, mask: det.mask })),
        overlay,
      };
    },
  });
  return { ...result, cached };
};

/**
 * The frame with every mask tinted over it: each mask PNG is decoded back
 * to pixels, and foreground pixels blend toward that detection's tint at
 * half strength, so the agent sees what the model saw — and where it
 * disagrees with the frame, the mask edge shows it.
 */
async function compositeOverlay(frame: HTMLCanvasElement | OffscreenCanvas, seg: SegmentWorkerResult): Promise<Uint8Array> {
  const { width, height } = frame;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(frame, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true })!;
  for (let i = 0; i < seg.detections.length; i++) {
    const det = seg.detections[i]!;
    if (det.mask.length === 0) continue;
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(det.mask)], { type: "image/png" }));
    try {
      // A mask that is not the frame's size is stretched over it — the
      // worker promises analyzed-frame size, this is belt and braces.
      scratchCtx.clearRect(0, 0, width, height);
      scratchCtx.drawImage(bitmap, 0, 0, width, height);
      const alpha = scratchCtx.getImageData(0, 0, width, height).data;
      const [r, g, b] = TINTS[i % TINTS.length]!;
      for (let p = 0, j = 0; p < alpha.length; p += 4, j += 4) {
        if (alpha[p]! > 127) {
          image.data[j] = (image.data[j]! + r) / 2;
          image.data[j + 1] = (image.data[j + 1]! + g) / 2;
          image.data[j + 2] = (image.data[j + 2]! + b) / 2;
        }
      }
    } finally {
      bitmap.close();
    }
  }
  ctx.putImageData(image, 0, 0);
  // Boxes on top, one per detection, in its tint.
  for (let i = 0; i < seg.detections.length; i++) {
    const [x1, y1, x2, y2] = seg.detections[i]!.bbox;
    const [r, g, b] = TINTS[i % TINTS.length]!;
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = Math.max(2, Math.round(width / 400));
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  }
  return encodePng(canvas);
}

/**
 * The worker speaks plain Errors over IPC; sort them into DAPI codes.
 * Unknown class names are the caller's mistake, everything else means the
 * platform cannot segment right now (no Python, no packages, dead worker).
 */
function segmentError(error: unknown): DapiError {
  const message = (error as Error).message;
  if (/unknown classes:/.test(message)) {
    return new DapiError(
      "invalid-input",
      `${message} Omit classes to segment all 80 COCO kinds, or use COCO names like person, car, or dog.`,
    );
  }
  return new DapiError("unsupported", message);
}
