/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, Bytes, outputDirField } from "../schemas";

/**
 * The analyzed frame's width cap, px: wider frames are downscaled before
 * the worker sees them (aspect preserved), and the depth map matches the
 * analyzed frame — see width/height. Same cap as segmentation, same
 * reason: a 4K 16-bit map over IPC buys nothing for a relative-depth net.
 */
export const DEPTH_MAX_WIDTH = 1280;

export const mediaDepth = defineTool({
  name: "media_depth",
  title: "Estimate depth",
  description:
    "Estimate relative depth for one frame of a video or image with a local Depth-Anything-V2-Small model (no credits): a 16-bit depth map for fog, depth-of-field, parallax, or foreground/background splits. Larger values are closer; the map is normalized per frame onto dmin..dmax, so compare depths within one frame, never across frames. One frame per call; video depth over time is not yet supported.",
  input: z.object({
    path: AssetPath,
    time: z.number().min(0).optional().describe("frame time in seconds for videos (default 0); images ignore it"),
    output: outputDirField,
  }),
  output: z.object({
    path: z.string(),
    time: z.number().describe("analyzed frame time in seconds (0 for images)"),
    width: z.number().describe("analyzed frame width, px"),
    height: z.number().describe("analyzed frame height, px"),
    engine: z.string().describe("depth engine id"),
    device: z.string().describe("where the model ran, e.g. cuda:0 or cpu"),
    ms: z.number().describe("worker inference time, milliseconds (excludes model load)"),
    dmin: z.number().describe("raw model minimum for this frame; depth-map 0 maps here"),
    dmax: z.number().describe("raw model maximum for this frame; depth-map 65535 maps here (larger = closer)"),
    depth: z.string().describe("absolute path of the 16-bit depth-map PNG"),
    preview: z.string().describe("absolute path of the grayscale preview (white = near), for eyeballing the result"),
    cached: z.boolean().describe("true when the result was reused from the analysis cache without re-running the model"),
  }),
  result: z.object({
    path: z.string(),
    time: z.number(),
    width: z.number(),
    height: z.number(),
    engine: z.string(),
    device: z.string(),
    ms: z.number(),
    dmin: z.number(),
    dmax: z.number(),
    depth: Bytes,
    preview: Bytes,
    cached: z.boolean(),
  }),
  environment: "renderer",
});
