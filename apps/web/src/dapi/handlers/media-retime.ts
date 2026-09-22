/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { getAssetFile } from "@diffusionstudio/runtime";
import { retime } from "@diffusionstudio/temporal";
import { DapiError } from "@diffusionstudio/dapi";
import { requireAssetType, resolveAsset } from "../lib/assets";

import type { SceneFrame } from "@diffusionstudio/scene";
import type { ToolHandler } from "../handler";

/** Retiming holds every frame: refuse past 60 seconds. */
const MAX_RETIME_SECONDS = 60;

/** Decode width for the scan; the map needs times, not pixels. */
const SCAN_WIDTH = 160;

export const mediaRetime: ToolHandler<"media_retime"> = async ({ path, fps, speed, reverse, freeze, ramp }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["VIDEO"], "a video");
  if (asset.duration > MAX_RETIME_SECONDS) {
    throw new DapiError(
      "invalid-input",
      `Retiming refuses files past 60 seconds; ${asset.path} is ${asset.duration.toFixed(0)} s. Trim a window first.`,
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
    for await (const wrapped of sink.canvases()) {
      const { canvas } = wrapped;
      const frame = canvas.getContext("2d", { willReadFrequently: true });
      if (!frame || !("getImageData" in frame)) {
        throw new DapiError("unsupported", "Retiming needs a 2D canvas context, which is unavailable.");
      }
      const pixels = frame.getImageData(0, 0, canvas.width, canvas.height).data;
      const data = new Uint8Array(canvas.width * canvas.height * 3);
      for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
        data[j] = pixels[i]!;
        data[j + 1] = pixels[i + 1]!;
        data[j + 2] = pixels[i + 2]!;
      }
      frames.push({ data, width: canvas.width, height: canvas.height, time: Math.max(0, wrapped.timestamp - firstTimestamp) });
    }
    if (!frames.length) throw new DapiError("not-found", `No frames could be decoded from ${asset.path}.`);

    let found;
    try {
      found = retime(frames, fps ?? asset.frameRate, {
        ...(speed !== undefined ? { speed } : {}),
        ...(reverse !== undefined ? { reverse } : {}),
        ...(freeze !== undefined ? { freeze } : {}),
        ...(ramp !== undefined ? { ramp } : {}),
      });
    } catch (error) {
      throw new DapiError("invalid-input", error instanceof Error ? error.message : String(error));
    }
    return {
      path: asset.path,
      map: found.map,
      outFrames: found.outFrames,
      outSeconds: found.outSeconds,
      srcFrames: found.srcFrames,
      srcSeconds: found.srcSeconds,
    };
  } finally {
    input.dispose();
  }
};
