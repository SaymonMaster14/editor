/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of a tracked point, as media_track returns it. Mirrors
 * @diffusionstudio/track's PointTrack, except positions are normalized
 * box centers (fractions of frame size) so they survive any resolution.
 */
export const PointTrackMeasurement = z.object({
  samples: z
    .array(
      z.object({
        time: z.number(),
        x: z.number().describe("box-center x as a fraction of frame width, 0–1"),
        y: z.number().describe("box-center y as a fraction of frame height, 0–1"),
        confidence: z.number().describe("template-match peak; under the lost threshold the sample reads as lost"),
        lost: z.boolean().describe("true when the subject was occluded, out of range, or ambiguous here"),
      }),
    )
    .describe("one sample per analyzed frame, ascending in time"),
  keyframe: z.number().describe("index of the sample the template came from"),
  frames: z.number().describe("decoded frames analyzed"),
  seconds: z.number().describe("analyzed program length, seconds"),
});
