/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of a reframing analysis, as media_reframe returns it.
 * Mirrors @diffusionstudio/reframe's Reframe: one crop window per frame
 * plus how much of the frame's saliency the trajectory kept in frame.
 */
export const ReframeMeasurement = z.object({
  crops: z
    .array(
      z.object({
        time: z.number(),
        x: z.number().describe("crop left, pixels at scan scale"),
        y: z.number().describe("crop top, pixels at scan scale"),
        width: z.number().describe("crop width, pixels at scan scale"),
        height: z.number().describe("crop height, pixels at scan scale"),
      }),
    )
    .describe("crop window per frame, ascending in time"),
  meanCoverage: z.number().describe("mean fraction of frame saliency inside the crop, 0-1"),
  frames: z.number().describe("decoded frames analyzed"),
  seconds: z.number().describe("analyzed program length, seconds"),
});
