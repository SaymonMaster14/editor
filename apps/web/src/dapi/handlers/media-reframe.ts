/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { getAssetFile } from "@diffusionstudio/runtime";
import { reframe } from "@diffusionstudio/reframe";
import { DapiError } from "@diffusionstudio/dapi";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { TrackFrame } from "@diffusionstudio/track";
import type { ToolHandler } from "../handler";

/** Reframing holds every frame's grayscale: refuse past 60 seconds. */
const MAX_REFRAME_SECONDS = 60;

/** Decode width for the scan; crop placement needs no more. */
const SCAN_WIDTH = 160;

export const mediaReframe: ToolHandler<"media_reframe"> = async ({ path, aspect, smoothing, cuts }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["VIDEO"], "a video");
  if (asset.duration > MAX_REFRAME_SECONDS) {
    throw new DapiError(
      "invalid-input",
      `Reframing refuses files past 60 seconds; ${asset.path} is ${asset.duration.toFixed(0)} s. Trim a window first.`,
    );
  }

  const blob = await getAssetFile(asset);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new DapiError("wrong-kind", `Asset ${asset.id} has no video track.`);

    // Track timestamps may not start at 0; offset content time by the first.
    const firstTimestamp = (await track.getFirstTimestamp()) ?? 0;
    const displayWidth = await track.getDisplayWidth();
    const sink = new CanvasSink(track, displayWidth > SCAN_WIDTH ? { width: SCAN_WIDTH } : undefined);

    const frames: TrackFrame[] = [];
    let width = 0;
    let height = 0;
    for await (const wrapped of sink.canvases()) {
      const { canvas } = wrapped;
      width = canvas.width;
      height = canvas.height;
      const frame = canvas.getContext("2d", { willReadFrequently: true });
      if (!frame || !("getImageData" in frame)) {
        throw new DapiError("unsupported", "Reframing needs a 2D canvas context, which is unavailable.");
      }
      const pixels = frame.getImageData(0, 0, width, height).data;
      const gray = new Uint8Array(width * height);
      for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
        gray[j] = 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
      }
      frames.push({ gray, width, height, time: Math.max(0, wrapped.timestamp - firstTimestamp) });
    }
    if (!frames.length) throw new DapiError("not-found", `No frames could be decoded from ${asset.path}.`);

    let found;
    try {
      found = reframe(frames, {
        aspect,
        ...(smoothing !== undefined ? { smoothing } : {}),
        ...(cuts !== undefined ? { cuts } : {}),
      });
    } catch (error) {
      throw new DapiError("invalid-input", error instanceof Error ? error.message : String(error));
    }
    return {
      path: asset.path,
      width,
      height,
      crops: found.crops,
      meanCoverage: found.meanCoverage,
      frames: found.frames,
      seconds: found.seconds,
    };
  } finally {
    input.dispose();
  }
};
