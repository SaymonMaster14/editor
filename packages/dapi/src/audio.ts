/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of measured loudness, shared by audio_loudness (which
 * measures a file) and export (which echoes the rendered mix's). Mirrors
 * @diffusionstudio/audio's LoudnessResult, except unmeasurable values are
 * null rather than -Infinity: JSON cannot carry infinities, and null reads
 * as what it is — silence, or too short to gate.
 */
export const LoudnessMeasurement = z.object({
  integratedLUFS: z.number().nullable().describe("gated integrated loudness; null when unmeasurable (silence, or under one 400 ms block)"),
  loudnessRangeLU: z.number().nullable().describe("10th–95th percentile spread of 3 s short-term loudness; null when fewer than two gated windows exist"),
  truePeakDbTP: z.number().nullable().describe("4x-oversampled true peak, dBTP; null for digital silence"),
  samplePeakDbFS: z.number().nullable().describe("sample peak, dBFS; null for digital silence"),
  seconds: z.number().describe("measured program length, seconds"),
});

/** A measured dB value as the wire carries it: finite, or null. */
export function finiteDb(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
