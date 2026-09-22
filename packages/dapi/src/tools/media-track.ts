/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetPath } from "../schemas";
import { PointTrackMeasurement } from "../track";

const unit = (label: string) => z.number().min(0).max(1).describe(`${label} as a fraction of frame size, 0–1`);

export const mediaTrack = defineTool({
  name: "media_track",
  title: "Track a point",
  description:
    "Follow a boxed subject through a video file (local decode, no credits): one position sample per frame with confidence, from a keyframe box. Translation only — scale and rotation are not followed. Occluded or out-of-range frames read as lost and recover when the subject returns. Grab a frame first to read the box off it; include background margin when the subject itself is textureless. Files over 60 seconds are refused.",
  input: z
    .object({
      path: AssetPath,
      time: z.number().min(0).optional().describe("keyframe time in seconds the box is drawn on (default 0)"),
      x: unit("box left"),
      y: unit("box top"),
      width: unit("box width"),
      height: unit("box height"),
      searchRadius: z
        .number()
        .positive()
        .optional()
        .describe("search radius around the last position, pixels at scan scale (default 24); raise for fast motion"),
      lostThreshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("match peak under this reads as lost (default 0.6); lower to hold through partial occlusion"),
    })
    .refine((v) => v.x + v.width <= 1 && v.y + v.height <= 1, {
      message: "the box must sit inside the 0–1 frame",
      path: ["width"],
    }),
  output: PointTrackMeasurement.extend({
    path: z.string(),
    width: z.number().describe("decoded scan width, px"),
    height: z.number().describe("decoded scan height, px"),
  }),
  environment: "renderer",
});
