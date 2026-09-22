/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";
import { KeyMeasurement } from "../key";

export const mediaKey = defineTool({
  name: "media_key",
  title: "Pull chroma key",
  description:
    "Analyze a chroma-key screen in a video file (local decode, no credits): estimated screen color, per-frame foreground/edge/spill fractions, and a verdict — clean, weak-screen (nothing saturated to key), or noisy (heavy feathering). Tune tolerance/softness and re-run to dial a key before compositing; pass an explicit screen color to override the border estimate. One global screen color: uneven screens and screen-colored subjects key partially. Returns analysis, not keyed footage. Files over 60 seconds are refused.",
  input: z.object({
    path: AssetPath,
    screen: z
      .tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)])
      .optional()
      .describe("screen color RGB; estimated from frame borders when omitted"),
    tolerance: z.number().min(0).optional().describe("color distance that still keys fully (default 60)"),
    softness: z.number().positive().optional().describe("feather band past tolerance (default 40)"),
  }),
  output: KeyMeasurement.extend({
    path: z.string(),
    width: z.number().describe("decoded scan width, px"),
    height: z.number().describe("decoded scan height, px"),
  }),
  environment: "renderer",
});
