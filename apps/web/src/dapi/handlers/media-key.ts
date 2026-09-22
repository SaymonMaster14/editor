/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { getAssetFile } from "@diffusionstudio/runtime";
import { keyClip } from "@diffusionstudio/keyer";
import { DapiError } from "@diffusionstudio/dapi";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { SceneFrame } from "@diffusionstudio/scene";
import type { ToolHandler } from "../handler";

/** Keying holds every frame's RGB: refuse past 60 seconds. */
const MAX_KEY_SECONDS = 60;

/** Decode width for the scan; key quality needs no more. */
const SCAN_WIDTH = 160;

export const mediaKey: ToolHandler<"media_key"> = async ({ path, screen, tolerance, softness }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["VIDEO"], "a video");
  if (asset.duration > MAX_KEY_SECONDS) {
    throw new DapiError(
      "invalid-input",
      `Keying refuses files past 60 seconds; ${asset.path} is ${asset.duration.toFixed(0)} s. Trim a window first.`,
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

    const frames: SceneFrame[] = [];
    let width = 0;
    let height = 0;
    for await (const wrapped of sink.canvases()) {
      const { canvas } = wrapped;
      width = canvas.width;
      height = canvas.height;
      const frame = canvas.getContext("2d", { willReadFrequently: true });
      if (!frame || !("getImageData" in frame)) {
        throw new DapiError("unsupported", "Keying needs a 2D canvas context, which is unavailable.");
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
      found = keyClip(frames, {
        ...(screen !== undefined ? { screen } : {}),
        ...(tolerance !== undefined ? { tolerance } : {}),
        ...(softness !== undefined ? { softness } : {}),
      });
    } catch (error) {
      throw new DapiError("invalid-input", error instanceof Error ? error.message : String(error));
    }
    return {
      path: asset.path,
      width,
      height,
      verdict: found.verdict,
      screen: found.screen,
      screenSaturation: found.screenSaturation,
      samples: found.samples,
      meanFg: found.meanFg,
      meanEdge: found.meanEdge,
      frames: found.frames,
      seconds: found.seconds,
    };
  } finally {
    input.dispose();
  }
};
