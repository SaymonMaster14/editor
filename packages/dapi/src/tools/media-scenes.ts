/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";
import { SceneMeasurement } from "../scene";

export const mediaScenes = defineTool({
  name: "media_scenes",
  title: "Detect cuts",
  description:
    "Detect hard cuts in a video file (local decode, no credits): cut times in seconds plus the shot list they imply, for finding shot boundaries, sampling one frame per shot, and aligning edits to cuts. Static footage returns no cuts and a single shot. Dissolves and fades are not detected; fast whip-pans can read as cuts. Files over 10 minutes are refused.",
  input: z.object({
    path: AssetPath,
    threshold: z
      .number()
      .positive()
      .optional()
      .describe("frame-dissimilarity a cut must reach, 0–2 (default 0.3); raise when motion trips false cuts, lower when soft cuts are missed"),
    minShotSeconds: z
      .number()
      .min(0)
      .optional()
      .describe("cuts closer than this collapse to the strongest (default 0.4); 0 keeps every cut"),
  }),
  output: SceneMeasurement.extend({
    path: z.string(),
    width: z.number().describe("decoded frame width, px"),
    height: z.number().describe("decoded frame height, px"),
  }),
  environment: "renderer",
});
