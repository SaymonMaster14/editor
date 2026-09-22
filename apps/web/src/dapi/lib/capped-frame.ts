/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { encodePng } from "@diffusionstudio/encoder";
import { DapiError } from "@diffusionstudio/dapi";

/**
 * The analyzed frame for the model workers: one decoded frame, downscaled
 * to `maxWidth` (aspect kept) when wider, as pixels for compositing plus
 * its PNG for the worker. Videos decode the frame at `at` seconds;
 * anything else decodes as a still image.
 */
export async function decodeCappedFrame(
  type: string,
  blob: Blob,
  at: number,
  maxWidth: number,
): Promise<{ canvas: HTMLCanvasElement | OffscreenCanvas; png: Uint8Array }> {
  if (type !== "VIDEO") {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = fitCanvas(bitmap.width, bitmap.height, maxWidth);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return { canvas, png: await encodePng(canvas) };
    } finally {
      bitmap.close();
    }
  }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new DapiError("wrong-kind", "The asset has no video track.");
    const firstTimestamp = (await track.getFirstTimestamp()) ?? 0;
    const displayWidth = await track.getDisplayWidth();
    const sink = new CanvasSink(track, displayWidth > maxWidth ? { width: maxWidth } : undefined);
    for await (const wrapped of sink.canvasesAtTimestamps([firstTimestamp + at])) {
      if (!wrapped) throw new DapiError("not-found", `No frame found at ${at}s.`);
      return { canvas: wrapped.canvas, png: await encodePng(wrapped.canvas) };
    }
    throw new DapiError("not-found", `No frame found at ${at}s.`);
  } finally {
    input.dispose();
  }
}

/** A canvas at the source size, or downscaled to the width cap (aspect kept). */
function fitCanvas(width: number, height: number, maxWidth: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  if (width > maxWidth) {
    canvas.width = maxWidth;
    canvas.height = Math.max(1, Math.round((height * maxWidth) / width));
  } else {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas;
}
