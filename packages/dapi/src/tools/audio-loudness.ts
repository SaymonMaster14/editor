/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { LoudnessMeasurement } from "../audio";
import { AssetPath } from "../schemas";

export const audioLoudness = defineTool({
  name: "audio_loudness",
  title: "Measure loudness",
  description:
    "Measure a media file's audio the way broadcast does (local decode, no credits): BS.1770 gated integrated loudness, loudness range, and 4x-oversampled true peak, streaming the whole primary audio track so long files cost constant memory. Use it to validate an export against a delivery spec, or — with `targetLUFS` — to get the master gain that lands the file on a loudness target (apply it as the scene's export `masterGainDb` and re-export). Nulls mean unmeasurable: digital silence, or under one 400 ms block.",
  input: z.object({
    path: AssetPath,
    targetLUFS: z
      .number()
      .optional()
      .describe("loudness target, LUFS (e.g. -16 for web, -14 for music platforms); returns suggestedGainDb = target − measured"),
  }),
  output: LoudnessMeasurement.extend({
    path: z.string(),
    sampleRate: z.number().describe("Hz"),
    channels: z.number().describe("decoded channel count"),
    targetLUFS: z.number().optional().describe("the requested target, echoed"),
    suggestedGainDb: z.number().nullable().describe("targetLUFS − integratedLUFS; null without a target or without a measurement"),
    cached: z.boolean().describe("true when the measurement was reused from the analysis cache without re-decoding"),
  }),
  environment: "renderer",
});
