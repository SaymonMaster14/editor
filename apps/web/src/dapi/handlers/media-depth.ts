/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { encodePng } from "@diffusionstudio/encoder";
import { getAssetFile } from "@diffusionstudio/runtime";
import { DapiError, DEPTH_ENGINE, DEPTH_ENGINE_VERSION, DEPTH_MAX_WIDTH } from "@diffusionstudio/dapi";
import { mainBridge } from "@/lib/ipc";
import { analyzeCached, mediaStore } from "../lib/analysis-cache";
import { requireAssetType, resolveAsset } from "../lib/assets";
import { decodeCappedFrame } from "../lib/capped-frame";

import type { DepthWorkerResult } from "@diffusionstudio/dapi";
import type { ToolHandler } from "../handler";

export const mediaDepth: ToolHandler<"media_depth"> = async ({ path, time }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["VIDEO", "IMAGE"], "a video or image");
  const at = time ?? 0;
  const duration = asset.type === "VIDEO" ? asset.duration : undefined;
  if (duration !== undefined && at > duration) {
    throw new DapiError("invalid-input", `time ${at}s is past the asset's duration (${duration.toFixed(2)}s).`);
  }

  const blob = await getAssetFile(asset);
  const { result, cached } = await analyzeCached({
    kind: "media_depth",
    engine: DEPTH_ENGINE,
    engineVersion: DEPTH_ENGINE_VERSION,
    source: blob,
    params: { time: at },
    ...(duration !== undefined ? { duration } : {}),
    cache: mediaStore,
    run: async () => {
      const frame = await decodeCappedFrame(asset.type, blob, at, DEPTH_MAX_WIDTH);
      let depth: DepthWorkerResult;
      try {
        depth = await mainBridge.call(MAIN_CHANNELS.DEPTH_RUN, { png: frame.png });
      } catch (error) {
        throw new DapiError("unsupported", (error as Error).message);
      }
      return {
        path: asset.path,
        time: asset.type === "VIDEO" ? at : 0,
        width: frame.canvas.width,
        height: frame.canvas.height,
        engine: DEPTH_ENGINE,
        device: depth.device,
        ms: depth.ms,
        dmin: depth.dmin,
        dmax: depth.dmax,
        depth: depth.depth,
        preview: await depthPreview(depth),
      };
    },
  });
  return { ...result, cached };
};

/**
 * The depth map as an 8-bit grayscale preview (white = near): the canvas
 * decodes the worker's 16-bit PNG down to 8 bits and re-encodes it. The
 * full-precision map ships separately as `depth`; this is only for eyes.
 */
async function depthPreview(depth: DepthWorkerResult): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(depth.depth)], { type: "image/png" }));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = depth.width;
    canvas.height = depth.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return encodePng(canvas);
  } finally {
    bitmap.close();
  }
}
