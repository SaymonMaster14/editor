/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of a scopes analysis, as media_scopes returns it.
 * Mirrors @diffusionstudio/color's ScopesAnalysis: per-frame scopes
 * plus the clip verdict and means.
 */
export const ScopesMeasurement = z.object({
  samples: z
    .array(
      z.object({
        time: z.number(),
        meanLuma: z.number(),
        lumaStd: z.number(),
        clippedBlack: z.number(),
        clippedWhite: z.number(),
        channelMeans: z.tuple([z.number(), z.number(), z.number()]),
        castToward: z.enum(["red", "green", "blue", "none"]),
        castStrength: z.number(),
        lumaHist: z.array(z.number()).describe("32-bin luma histogram, counts"),
        rgbHist: z.tuple([z.array(z.number()), z.array(z.number()), z.array(z.number())]).describe("32-bin per-channel histograms"),
        waveform: z.array(z.tuple([z.number(), z.number()])).describe("8 horizontal waveform strips as [min,max] luma"),
      }),
    )
    .describe("scopes per frame, ascending in time"),
  verdict: z.enum(["balanced", "clipped-black", "clipped-white", "cast", "flat"]),
  meanLuma: z.number(),
  meanClippedBlack: z.number(),
  meanClippedWhite: z.number(),
  meanCastStrength: z.number(),
  frames: z.number().describe("decoded frames analyzed"),
  seconds: z.number().describe("analyzed program length, seconds"),
});
