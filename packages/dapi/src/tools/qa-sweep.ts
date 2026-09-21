/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { checkSheetOptions, ImageRef, outputDirField, SceneId, sheetFields } from "../schemas";
import { NonNegativeTime } from "../time";
import { QaFinding, QaFrameAnalysis, QaReceiptRef, QaSweepMode } from "../qa";

export const qaSweep = defineTool({
  name: "qa_sweep",
  title: "Visual QA sweep",
  description:
    "Inspect a scene the way an export would see it: sample its timeline at scene-aware positions (scene start/end, clip and text entrances, keyframes, suspicious gaps, plus regular coverage), render those frames to contact sheets, and analyze each one — deterministic layout findings (offscreen/clipped/unsafe text, text overlaps, stretched media, black or flat renders) plus per-frame luminance. Returns the sheets and a QA receipt: every sampled frame with its timecode, sha256 and pixel-delivery evidence (inline = the pixels rode in this result; path = open the file), and the findings with frame stamps. The tool for the edit-render-see-fix loop: sweep, read the receipt, look at the sheets, fix, sweep again and compare hashes. Use capture for ad-hoc frames and check for structure without rendering.",
  input: z
    .object({
      id: SceneId,
      mode: QaSweepMode.optional().describe("landmarks: timeline events only; regular: even coverage only; auto: both (default)"),
      maxFrames: z
        .int()
        .min(1)
        .max(48)
        .optional()
        .describe("positions to sample at most (default: 12, one contact sheet)"),
      times: z
        .array(NonNegativeTime)
        .optional()
        .describe("extra positions to sample, same clock as capture (seconds, frames, or MM:SS)"),
      ...sheetFields,
      output: outputDirField,
    })
    .superRefine(checkSheetOptions),
  output: z.object({ images: z.array(ImageRef), receipt: QaReceiptRef }),
  result: z.object({
    scene: z.string().describe("the swept scene's stamp"),
    images: z.array(z.object({ timecode: z.string(), png: z.custom<Uint8Array>((value) => value instanceof Uint8Array) })),
    /** Capture-clock frames each image shows, in cell order; one entry per image. */
    cells: z.array(z.array(z.number().int())),
    frames: z.array(QaFrameAnalysis),
    findings: z.array(QaFinding),
    fps: z.number(),
    mode: QaSweepMode,
  }),
  environment: "renderer",
});
