/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";
import { ReframeMeasurement } from "../reframe";

export const mediaReframe = defineTool({
  name: "media_reframe",
  title: "Plan reframe crop",
  description:
    "Plan an intelligent reframe of a video file (local decode, no credits): a smooth per-frame crop trajectory at the target aspect that follows textured/moving subject matter, for Shorts-style 9:16 or 1:1 crops. Pass shot cuts from media_scenes so framing resets cleanly at each cut. Saliency is edges plus motion, not faces or text — verify framing on real footage. Returns analysis, not a cropped video. Files over 60 seconds are refused.",
  input: z.object({
    path: AssetPath,
    aspect: z.string().describe('target aspect as "W:H", e.g. "9:16" or "1:1"'),
    smoothing: z.number().min(0).optional().describe("Gaussian smoothing sigma for the crop path, frames (default 10); 0 disables"),
    cuts: z.array(z.number()).optional().describe("cut times in seconds; the crop path resets across them"),
  }),
  output: ReframeMeasurement.extend({
    path: z.string(),
    width: z.number().describe("decoded scan width, px"),
    height: z.number().describe("decoded scan height, px"),
    cached: z.boolean().describe("true when the result was reused from the analysis cache without re-decoding"),
  }),
  environment: "renderer",
});
