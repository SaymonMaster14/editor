/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import {
  AssetPath,
  ImageRef,
  TimecodedImage,
  checkSheetOptions,
  checkWindow,
  outputDirField,
  sheetFields,
  windowFields,
} from "../schemas";
import { Time } from "../time";
import { FrameQuality } from "./media-grab";

/** Effect previews decode and transform every frame: hard cap, no override. */
export const EFFECTS_FRAME_CAP = 30;

/** At most this many entries per stack; deeper stacks are a sign of confusion, not craft. */
export const EFFECTS_STACK_CAP = 8;

export const EffectStep = z.object({
  kind: z
    .enum(["grain", "vignette", "rgbSplit", "pixelate", "scanlines", "shake", "posterize"])
    .describe(
      "grain (film grain), vignette (darkened corners), rgbSplit (chromatic fringe), pixelate (mosaic blocks), scanlines (CRT rows), shake (camera wobble), posterize (color banding)",
    ),
  params: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      "per-kind numbers — grain: amount 0-64, seed; vignette: strength 0-1; rgbSplit: distance 0-64px; pixelate: size 2-128px; scanlines: amount 0-1, pitch 2-8; shake: amplitude 0-64px, frequency 0.5-30Hz, seed; posterize: levels 2-16. Unknown or out-of-range params fail.",
    ),
});

export const mediaEffects = defineTool({
  name: "media_effects",
  title: "Preview effects",
  description:
    "Render a procedural effect stack over decoded frames of a video file and write contact sheets (local render, no credits): grain, vignette, RGB split, pixelation, scanlines, camera shake, posterize — applied in order, deterministic for the same stack, with grain and shake evolving over time. A preview tool: it renders pixels for inspection, it does not edit the project or export footage. Files are sampled (times or count, at most 30 frames), never fully rendered.",
  input: z
    .object({
      path: AssetPath,
      effects: z
        .array(EffectStep)
        .min(1)
        .max(EFFECTS_STACK_CAP)
        .describe("the stack, applied first entry to last; later entries see earlier entries' pixels"),
      times: z
        .array(Time)
        .optional()
        .describe(
          'timestamps to render — seconds ("1.5"), frames ("45f"), or "MM:SS"; negatives count back from the end (default: [0])',
        ),
      count: z
        .int()
        .min(1)
        .optional()
        .describe("instead of times, render this many frames evenly spaced across the clip (or across the start/end window)"),
      start: windowFields.start.describe("with count, start of the window to sample (default: 0)"),
      end: windowFields.end.describe("with count, end of the window to sample (default: asset duration)"),
      quality: FrameQuality.optional().describe(
        "frame resolution as a pixel budget, aspect ratio kept and never enlarged past the source: small (384² pixels, 512x288 for 16:9), medium (768², 1024x576), large (1536², 2048x1152), or fullres (native); default: medium",
      ),
      ...sheetFields,
      output: outputDirField,
    })
    .superRefine((value, ctx) => {
      if (value.times !== undefined && value.count !== undefined) {
        ctx.addIssue({ code: "custom", path: ["count"], message: "pass either times or count, not both" });
      }
      const windowed = value.start !== undefined || value.end !== undefined;
      if (windowed && value.count === undefined) {
        ctx.addIssue({ code: "custom", path: ["start"], message: "start and end only apply together with count" });
      }
      checkWindow(value, ctx);
      const requested = value.count ?? value.times?.length ?? 1;
      if (requested > EFFECTS_FRAME_CAP) {
        ctx.addIssue({
          code: "custom",
          path: [value.count !== undefined ? "count" : "times"],
          message: `rendering ${requested} frames exceeds the ${EFFECTS_FRAME_CAP}-frame cap; sample fewer frames`,
        });
      }
      checkSheetOptions(value, ctx);
    }),
  output: z.object({
    path: z.string(),
    images: z.array(ImageRef),
    frames: z.number().describe("frames rendered"),
    cached: z.boolean().describe("true when the sheets were reused from the analysis cache without re-rendering"),
  }),
  result: z.object({
    path: z.string(),
    images: z.array(TimecodedImage),
    frames: z.number(),
    cached: z.boolean(),
  }),
  environment: "renderer",
});
