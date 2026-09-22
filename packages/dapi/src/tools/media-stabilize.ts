/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";
import { StabilizationMeasurement } from "../stabilize";

export const mediaStabilize = defineTool({
  name: "media_stabilize",
  title: "Measure stabilization",
  description:
    "Measure camera shake in a video file (local decode, no credits): per-frame camera positions plus the frame translations that cancel the shake, for building stabilized renders or judging how shaky a clip is. Translation only — rotation and zoom are not measured. Textureless footage reads as invalid rather than steady. Returns analysis, not a stabilized video. Files over 60 seconds are refused.",
  input: z.object({
    path: AssetPath,
    patches: z.number().int().positive().optional().describe("anchor patches to track and median (default 5)"),
    patchSize: z.number().int().min(4).optional().describe("anchor patch edge, pixels at scan scale (default 24)"),
    searchRadius: z.number().positive().optional().describe("search radius per patch, pixels (default 12)"),
    smoothing: z
      .number()
      .min(0)
      .optional()
      .describe("Gaussian smoothing sigma, frames (default 30); 0 disables smoothing and zeroes corrections"),
  }),
  output: StabilizationMeasurement.extend({
    path: z.string(),
    width: z.number().describe("decoded scan width, px"),
    height: z.number().describe("decoded scan height, px"),
  }),
  environment: "renderer",
});
