/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { getAssetFile } from "@diffusionstudio/runtime";
import { scopeClip } from "@diffusionstudio/color";
import { DapiError } from "@diffusionstudio/dapi";
import { analyzeCached } from "../lib/analysis-cache";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { SceneFrame } from "@diffusionstudio/scene";
import type { ToolHandler } from "../handler";

/** Scopes hold every frame's RGB: refuse past 60 seconds. */
const MAX_SCOPES_SECONDS = 60;

/** Decode width for the scan; scopes need no more. */
const SCAN_WIDTH = 160;

export const mediaScopes: ToolHandler<"media_scopes"> = async ({ path }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["VIDEO"], "a video");
  if (asset.duration > MAX_SCOPES_SECONDS) {
    throw new DapiError(
      "invalid-input",
      `Scopes refuse files past 60 seconds; ${asset.path} is ${asset.duration.toFixed(0)} s. Trim a window first.`,
    );
  }

  const blob = await getAssetFile(asset);
  const { result, cached } = await analyzeCached({
    kind: "media_scopes",
    engine: "diffusion-color",
    engineVersion: "1",
    source: blob,
    params: {},
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

        const frames: SceneFrame[] = [];
        let width = 0;
        let height = 0;
        for await (const wrapped of sink.canvases()) {
          const { canvas } = wrapped;
          width = canvas.width;
          height = canvas.height;
          const frame = canvas.getContext("2d", { willReadFrequently: true });
          if (!frame || !("getImageData" in frame)) {
            throw new DapiError("unsupported", "Scopes need a 2D canvas context, which is unavailable.");
          }
          const pixels = frame.getImageData(0, 0, width, height).data;
          const data = new Uint8Array(width * height * 3);
          for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
            data[j] = pixels[i]!;
            data[j + 1] = pixels[i + 1]!;
            data[j + 2] = pixels[i + 2]!;
          }
          frames.push({ data, width, height, time: Math.max(0, wrapped.timestamp - firstTimestamp) });
        }
        if (!frames.length) throw new DapiError("not-found", `No frames could be decoded from ${asset.path}.`);

        let found;
        try {
          found = scopeClip(frames);
        } catch (error) {
          throw new DapiError("invalid-input", error instanceof Error ? error.message : String(error));
        }
        return {
          path: asset.path,
          width,
          height,
          samples: found.samples,
          verdict: found.verdict,
          meanLuma: found.meanLuma,
          meanClippedBlack: found.meanClippedBlack,
          meanClippedWhite: found.meanClippedWhite,
          meanCastStrength: found.meanCastStrength,
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
