/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of a chroma-key analysis, as media_key returns it.
 * Mirrors @diffusionstudio/keyer's KeyAnalysis: the screen estimate,
 * per-frame matte samples, means, and the key-quality verdict.
 */
export const KeyMeasurement = z.object({
  verdict: z.enum(["clean", "weak-screen", "noisy"]).describe("key quality: saturated screen and calm edges, nothing to key, or heavy feathering"),
  screen: z.tuple([z.number(), z.number(), z.number()]).describe("estimated or given screen color, RGB 0-255"),
  screenSaturation: z.number().describe("saturation of the screen, 0-1"),
  samples: z
    .array(
      z.object({
        time: z.number(),
        fgFraction: z.number().describe("fraction of pixels fully foreground"),
        edgeFraction: z.number().describe("fraction of pixels semi-transparent"),
        spillFraction: z.number().describe("fraction of foreground pixels the despill touched"),
      }),
    )
    .describe("matte samples per frame, ascending in time"),
  meanFg: z.number().describe("mean foreground fraction across frames"),
  meanEdge: z.number().describe("mean edge fraction across frames"),
  frames: z.number().describe("decoded frames analyzed"),
  seconds: z.number().describe("analyzed program length, seconds"),
});
