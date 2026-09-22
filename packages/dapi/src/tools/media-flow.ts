/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, Bytes, outputDirField } from "../schemas";

/**
 * The analyzed frames' width cap, px: wider frames are downscaled before
 * the worker sees them (aspect preserved), and the flow field matches the
 * analyzed frames — see width/height. Same cap as segmentation and depth,
 * same reason: RAFT-small buys nothing from 4K pixels, and both frames
 * must share one size.
 */
export const FLOW_MAX_WIDTH = 1280;

export const mediaFlow = defineTool({
  name: "media_flow",
  title: "Estimate optical flow",
  description:
    "Estimate dense optical flow between two frames of a video with local models (no credits): per-pixel motion for stabilization, retiming, motion masks, or shot-change cues. The raft engine (RAFT-small, GPU when available) is the quality pick; dis (OpenCV DIS, CPU-only) is the fast pick with no weights. Returns a full-precision .npy flow field plus a Middlebury visualization. One frame pair per call; video-wide flow over time is not yet supported.",
  input: z.object({
    path: AssetPath,
    time: z.number().min(0).optional().describe("first frame time in seconds (default 0)"),
    dt: z.number().positive().optional().describe("gap to the second frame in seconds (default 1/30, about one frame)"),
    engine: z.enum(["dis", "raft"]).optional().describe("flow engine: raft for quality, dis for speed (default raft)"),
    output: outputDirField,
  }),
  output: z.object({
    path: z.string(),
    time: z.number().describe("first analyzed frame time in seconds"),
    timeB: z.number().describe("second analyzed frame time in seconds"),
    width: z.number().describe("analyzed frame width, px"),
    height: z.number().describe("analyzed frame height, px"),
    engine: z.string().describe("flow engine id"),
    device: z.string().describe("where the engine ran, e.g. cuda:0 or cpu"),
    ms: z.number().describe("worker inference time, milliseconds (excludes model load)"),
    meanMag: z.number().describe("mean flow magnitude over the frame, px"),
    p95Mag: z.number().describe("95th-percentile magnitude, px"),
    flow: z.string().describe("absolute path of the .npy float32 HxWx2 flow field"),
    preview: z.string().describe("absolute path of the Middlebury visualization PNG, for eyeballing the result"),
    cached: z.boolean().describe("true when the result was reused from the analysis cache without re-running the engine"),
  }),
  result: z.object({
    path: z.string(),
    time: z.number(),
    timeB: z.number(),
    width: z.number(),
    height: z.number(),
    engine: z.string(),
    device: z.string(),
    ms: z.number(),
    meanMag: z.number(),
    p95Mag: z.number(),
    flow: Bytes,
    preview: Bytes,
    cached: z.boolean(),
  }),
  environment: "renderer",
});
