/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of detected hard cuts, as media_scenes returns it.
 * Mirrors @diffusionstudio/scene's CutDetection: cuts are the first
 * frame of each new shot, shots span the analyzed footage.
 */
export const SceneMeasurement = z.object({
  cuts: z.array(z.number()).describe("cut times in seconds, ascending; empty for a single static shot"),
  shots: z
    .array(z.object({ index: z.number(), start: z.number(), end: z.number() }))
    .describe("shots spanning the analyzed footage, in order"),
  frames: z.number().describe("decoded frames analyzed"),
  seconds: z.number().describe("analyzed program length, seconds"),
});
