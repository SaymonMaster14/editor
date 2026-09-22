/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { BeatGridMeasurement } from "../audio";
import { AssetPath } from "../schemas";

export const audioBeats = defineTool({
  name: "audio_beats",
  title: "Track beats",
  description:
    "Track a media file's beat grid (local decode, no credits): estimated BPM plus per-beat and per-onset times in seconds, for syncing cuts, captions, and effects to music. Percussive material (drums, clicks, plucky attacks) tracks well; legato drones and silence return a null bpm with no beats rather than a hallucinated tempo. Downbeats are not detected. Files over 30 minutes are refused.",
  input: z.object({
    path: AssetPath,
    minBpm: z
      .number()
      .positive()
      .optional()
      .describe("slowest tempo to consider (default 60); narrow the range when the genre is known"),
    maxBpm: z
      .number()
      .positive()
      .optional()
      .describe("fastest tempo to consider (default 200)"),
  }).refine((v) => v.minBpm === undefined || v.maxBpm === undefined || v.minBpm < v.maxBpm, {
    message: "minBpm must be less than maxBpm",
    path: ["maxBpm"],
  }),
  output: BeatGridMeasurement.extend({
    path: z.string(),
    sampleRate: z.number().describe("Hz"),
    channels: z.number().describe("decoded channel count"),
    cached: z.boolean().describe("true when the result was reused from the analysis cache without re-decoding"),
  }),
  environment: "renderer",
});
