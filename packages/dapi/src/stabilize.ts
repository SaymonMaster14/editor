/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of a stabilization analysis, as media_stabilize returns
 * it. Mirrors @diffusionstudio/stabilize's Stabilization: per-frame
 * camera positions plus the frame translations that cancel the shake.
 */
export const StabilizationMeasurement = z.object({
  motion: z
    .array(
      z.object({
        time: z.number(),
        dx: z.number().describe("camera x relative to the keyframe, pixels at scan scale"),
        dy: z.number().describe("camera y relative to the keyframe, pixels at scan scale"),
        valid: z.boolean().describe("false when no anchor tracked this frame"),
      }),
    )
    .describe("raw camera position per frame, ascending in time"),
  correction: z
    .array(
      z.object({
        time: z.number(),
        dx: z.number().describe("translate the frame by this x, pixels at scan scale, to stabilize"),
        dy: z.number().describe("translate the frame by this y, pixels at scan scale, to stabilize"),
        valid: z.boolean(),
      }),
    )
    .describe("per-frame stabilizing correction, ascending in time"),
  shakeRms: z.number().describe("RMS(raw − smooth) over valid frames, pixels: the removed shake"),
  maxCorrection: z.number().describe("largest correction magnitude over valid frames, pixels"),
  validFrames: z.number(),
  keyframe: z.number().describe("index of the sample the anchors came from"),
  frames: z.number().describe("decoded frames analyzed"),
  seconds: z.number().describe("analyzed program length, seconds"),
});
