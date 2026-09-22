/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { Bytes } from "./schemas";

/** The weights file the segmentation worker loads. Bumped with the worker protocol, not the model run. */
export const SEGMENT_ENGINE = "yolo11n-seg";
export const SEGMENT_ENGINE_VERSION = "yolo11n-seg.pt/worker-1";

/**
 * One instance the worker found: class, confidence, box in analyzed-frame
 * pixels, foreground pixel count, and the full-frame mask as a grayscale
 * PNG (255 = this instance) at the analyzed frame's size.
 */
export const SegmentDetection = z.object({
  cls: z.string().describe("COCO class name, e.g. person"),
  cls_id: z.number().describe("COCO class id"),
  conf: z.number().describe("detector confidence, 0–1"),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[x1, y1, x2, y2] in analyzed-frame pixels"),
  area: z.number().describe("foreground pixels in the mask"),
  mask: Bytes.describe("grayscale mask PNG at the analyzed frame's size"),
});

export type SegmentDetection = z.output<typeof SegmentDetection>;

/** The detection as the caller receives it: the mask is a written file. */
export const SegmentDetectionRef = SegmentDetection.omit({ mask: true }).extend({
  mask: z.string().describe("absolute path of the written mask PNG"),
});

export type SegmentDetectionRef = z.output<typeof SegmentDetectionRef>;

/**
 * What the main-process segmentation worker answers over the SEGMENT_RUN
 * channel: the analyzed size, which device ran, inference milliseconds,
 * and the detections with raw mask bytes. Plain types, not zod — the
 * driver validates the worker's JSON before it crosses IPC.
 */
export type SegmentWorkerDetection = {
  cls: string;
  cls_id: number;
  conf: number;
  bbox: [number, number, number, number];
  area: number;
  mask: Uint8Array;
};

export type SegmentWorkerResult = {
  width: number;
  height: number;
  device: string;
  ms: number;
  detections: SegmentWorkerDetection[];
};
