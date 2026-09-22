/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of a retiming analysis, as media_retime returns it.
 * Mirrors @diffusionstudio/temporal's Retime: one source-time entry
 * per output frame plus the in/out counts and durations.
 */
export const RetimeMeasurement = z.object({
  map: z
    .array(
      z.object({
        time: z.number().describe("output time, seconds"),
        src: z.number().describe("source time this output frame shows, seconds"),
      }),
    )
    .describe("source time per output frame, ascending in output time"),
  outFrames: z.number().describe("output frame count at the output fps"),
  outSeconds: z.number().describe("output duration, seconds"),
  srcFrames: z.number().describe("decoded source frames"),
  srcSeconds: z.number().describe("source program length, seconds"),
});
