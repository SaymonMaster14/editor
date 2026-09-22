/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";
import { ScopesMeasurement } from "../color";

export const mediaScopes = defineTool({
  name: "media_scopes",
  title: "Read color scopes",
  description:
    "Read color scopes for a video file (local decode, no credits): per-frame luma mean/spread, clipped black/white fractions, channel means, cast read, luma and RGB histograms, and waveform strips, plus a clip verdict — clipped-white, clipped-black, cast, flat, or balanced. Verdicts describe pixels, not taste. Returns analysis, not graded footage. Files over 60 seconds are refused.",
  input: z.object({
    path: AssetPath,
  }),
  output: ScopesMeasurement.extend({
    path: z.string(),
    width: z.number().describe("decoded scan width, px"),
    height: z.number().describe("decoded scan height, px"),
    cached: z.boolean().describe("true when the result was reused from the analysis cache without re-decoding"),
  }),
  environment: "renderer",
});
