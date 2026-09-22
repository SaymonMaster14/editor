/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { getAssetFile } from "@diffusionstudio/runtime";
import { CutScanner } from "@diffusionstudio/scene";
import { DapiError } from "@diffusionstudio/dapi";
import { analyzeCached } from "../lib/analysis-cache";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { ToolHandler } from "../handler";

/** Cut detection decodes every frame: refuse past 10 minutes of footage. */
const MAX_SCENES_SECONDS = 10 * 60;

/** Decode width for the scan; histograms need thumbnails, not pixels. */
const SCAN_WIDTH = 160;

export const mediaScenes: ToolHandler<"media_scenes"> = async ({ path, threshold, minShotSeconds }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["VIDEO"], "a video");
  if (asset.duration > MAX_SCENES_SECONDS) {
    throw new DapiError(
      "invalid-input",
      `Cut detection refuses files past 10 minutes; ${asset.path} is ${asset.duration.toFixed(0)} s. Trim a window first.`,
    );
  }

  const blob = await getAssetFile(asset);
  const { result, cached } = await analyzeCached({
    kind: "media_scenes",
    engine: "diffusion-scene",
    engineVersion: "1",
    source: blob,
    params: { threshold, minShotSeconds },
    duration: asset.duration,
    run: async () => {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new DapiError("wrong-kind", `Asset ${asset.id} has no video track.`);

        // Track timestamps may not start at 0; offset content time by the first.
        const firstTimestamp = (await track.getFirstTimestamp()) ?? 0;
        const displayWidth = await track.getDisplayWidth();
        const sink = new CanvasSink(track, displayWidth > SCAN_WIDTH ? { width: SCAN_WIDTH } : undefined);

        const scanner = new CutScanner({
          ...(threshold !== undefined ? { threshold } : {}),
          ...(minShotSeconds !== undefined ? { minShotSeconds } : {}),
        });
        let width = 0;
        let height = 0;
        // Streaming: each frame's pixels are histogrammed and dropped, so the
        // scan holds one histogram per frame instead of one frame per frame.
        for await (const wrapped of sink.canvases()) {
          const { canvas } = wrapped;
          width = canvas.width;
          height = canvas.height;
          const frame = canvas.getContext("2d", { willReadFrequently: true });
          if (!frame || !("getImageData" in frame)) {
            throw new DapiError("unsupported", "Cut detection needs a 2D canvas context, which is unavailable.");
          }
          const pixels = frame.getImageData(0, 0, width, height).data;
          const rgb = new Uint8Array((pixels.length / 4) * 3);
          for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
            rgb[j] = pixels[i]!;
            rgb[j + 1] = pixels[i + 1]!;
            rgb[j + 2] = pixels[i + 2]!;
          }
          scanner.push({ data: rgb, width, height, time: Math.max(0, wrapped.timestamp - firstTimestamp) });
        }
        if (!scanner.frames) throw new DapiError("not-found", `No frames could be decoded from ${asset.path}.`);

        const found = scanner.result();
        return {
          path: asset.path,
          width,
          height,
          cuts: found.cuts,
          shots: found.shots,
          frames: found.frames,
          seconds: found.seconds,
        };
      } finally {
        input.dispose();
      }
    },
  });
  return { ...result, cached };
};
