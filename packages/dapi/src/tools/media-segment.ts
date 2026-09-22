/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath, Bytes, outputDirField } from "../schemas";
import { SegmentDetection, SegmentDetectionRef } from "../segment";

/**
 * The analyzed frame's width cap, px: wider frames are downscaled before
 * the worker sees them (aspect preserved), and every box and mask is in
 * the analyzed frame's pixels — map them back by width/height when the
 * source is bigger. 1280 keeps YOLO's small masks honest without making
 * every call ship a 4K PNG over IPC.
 */
export const SEGMENT_MAX_WIDTH = 1280;

export const mediaSegment = defineTool({
  name: "media_segment",
  title: "Segment a frame",
  description:
    "Segment one frame of a video or image with a local YOLO11n-seg model (no credits): per-instance class, confidence, box, and a full-frame mask PNG for building text-behind-subject, background blur, or isolation effects. Prompt with COCO class names (person, car, dog, …); omit classes for all 80. Boxes and masks are in analyzed-frame pixels at most 1280 wide — see width/height. One frame per call; tracking a mask across time is not yet supported.",
  input: z.object({
    path: AssetPath,
    time: z.number().min(0).optional().describe("frame time in seconds for videos (default 0); images ignore it"),
    classes: z
      .array(z.string())
      .optional()
      .describe("COCO class names to keep, e.g. [person]; an unknown name fails with the valid list hint (default all)"),
    conf: z.number().min(0).max(1).optional().describe("detector confidence threshold (default 0.25)"),
    output: outputDirField,
  }),
  output: z.object({
    path: z.string(),
    time: z.number().describe("analyzed frame time in seconds (0 for images)"),
    width: z.number().describe("analyzed frame width, px"),
    height: z.number().describe("analyzed frame height, px"),
    engine: z.string().describe("segmentation engine id"),
    device: z.string().describe("where the model ran, e.g. cuda:0 or cpu"),
    ms: z.number().describe("worker inference time, milliseconds (excludes model load)"),
    detections: z.array(SegmentDetectionRef),
    overlay: z.string().describe("absolute path of the frame with every mask tinted, for eyeballing the result"),
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
    detections: z.array(SegmentDetection),
    overlay: Bytes,
    cached: z.boolean(),
  }),
  environment: "renderer",
});
