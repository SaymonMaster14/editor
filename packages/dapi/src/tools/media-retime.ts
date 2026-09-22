/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";
import { RetimeMeasurement } from "../retime";

export const mediaRetime = defineTool({
  name: "media_retime",
  title: "Plan retime map",
  description:
    "Plan a retime of a video file (local decode, no credits): the per-output-frame source-time map for a base speed, reverse, freeze holds, and a piecewise-linear speed ramp over source seconds — for slow motion, speed ramps, and freeze frames. Sampling is nearest-frame or cross-dissolve blend; there is no optical flow, so slow motion past ~0.5x strobes on fast movement. Returns analysis, not retimed footage. Files over 60 seconds are refused.",
  input: z.object({
    path: AssetPath,
    fps: z.number().positive().optional().describe("output frames per second (default: source fps)"),
    speed: z.number().positive().optional().describe("base speed multiplier (default 1)"),
    reverse: z.boolean().optional().describe("play the map backwards (default false)"),
    freeze: z
      .array(z.object({ at: z.number(), hold: z.number().min(0) }))
      .optional()
      .describe("freeze holds: source seconds to hold and output seconds each lasts"),
    ramp: z
      .array(z.object({ time: z.number(), speed: z.number().positive() }))
      .optional()
      .describe("speed ramp keys in source seconds, strictly ascending"),
  }),
  output: RetimeMeasurement.extend({
    path: z.string(),
    cached: z.boolean().describe("true when the result was reused from the analysis cache without re-decoding"),
  }),
  environment: "renderer",
});
