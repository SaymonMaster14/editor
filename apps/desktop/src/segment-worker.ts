/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Buffer } from "node:buffer";
import { ModelWorker, resolveWorkerPython, workerPaths } from "./model-worker";

import type { PythonProbe } from "./model-worker";
import type { WorkerPathsInput } from "./model-worker";
import type { ModelWorkerDeps } from "./model-worker";
import type { SegmentWorkerDetection, SegmentWorkerResult } from "@diffusionstudio/dapi";

/**
 * The segmentation worker: a ModelWorker speaking workers/segment.py's
 * protocol (info/segment/shutdown over YOLO11n-seg). The transport —
 * spawn, queue, restart, stop — lives in model-worker; this file is the
 * worker's imports, paths, response parsing, and error hints.
 */

/** The interpreter must import all of these for segmentation to run. */
export const SEGMENT_IMPORTS = ["ultralytics", "cv2", "torch"];

export function resolvePython(env?: NodeJS.ProcessEnv, probe?: PythonProbe): string[] | null {
  return resolveWorkerPython(SEGMENT_IMPORTS, env, probe);
}

export function segmentPaths(input: WorkerPathsInput): { scriptPath: string; modelsDir: string } {
  return workerPaths(input, "segment.py");
}

export type SegmentCallOptions = {
  classes?: string[];
  conf?: number;
};

export type SegmentWorkerDeps = Omit<ModelWorkerDeps, "extraEnv">;

export class SegmentWorker extends ModelWorker {
  constructor(deps: SegmentWorkerDeps) {
    super({
      ...deps,
      extraEnv: {
        // Weights and settings stay inside our models dir, not the
        // user's global Ultralytics config.
        YOLO_CONFIG_DIR: deps.modelsDir,
        ULTRALYTICS_SETTINGS_DIR: deps.modelsDir,
      },
    });
  }

  override async call(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await super.call(request);
    } catch (error) {
      throw new Error(withHint((error as Error).message));
    }
  }

  /** Model id, device, and the valid class names — also a cheap health check. */
  async info(): Promise<{ model: string; device: string; classes: string[] }> {
    const res = await this.call({ cmd: "info" });
    if (typeof res.model !== "string" || typeof res.device !== "string" || !Array.isArray(res.classes)) {
      throw new Error("The segmentation worker answered info with a shape this app cannot read.");
    }
    return { model: res.model, device: res.device, classes: res.classes as string[] };
  }

  async segment(png: Uint8Array, options: SegmentCallOptions = {}): Promise<SegmentWorkerResult> {
    const res = await this.call({
      cmd: "segment",
      image_b64: Buffer.from(png).toString("base64"),
      ...(options.classes !== undefined ? { classes: options.classes } : {}),
      ...(options.conf !== undefined ? { conf: options.conf } : {}),
    });
    return parseSegmentResult(res);
  }
}

function parseSegmentResult(res: Record<string, unknown>): SegmentWorkerResult {
  const { width, height, device, ms, detections } = res;
  if (typeof width !== "number" || typeof height !== "number" || typeof device !== "string" || !Array.isArray(detections)) {
    throw new Error("The segmentation worker answered segment with a shape this app cannot read.");
  }
  return {
    width,
    height,
    device,
    ms: typeof ms === "number" ? ms : 0,
    detections: detections.map((item) => parseDetection(item)),
  };
}

function parseDetection(item: unknown): SegmentWorkerDetection {
  const det = item as Record<string, unknown>;
  const bbox = det?.bbox;
  const maskB64 = det?.mask_b64;
  if (
    typeof det?.cls !== "string" ||
    typeof det?.cls_id !== "number" ||
    typeof det?.conf !== "number" ||
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every((v) => typeof v === "number") ||
    typeof det?.area !== "number" ||
    typeof maskB64 !== "string"
  ) {
    throw new Error("The segmentation worker returned a detection this app cannot read.");
  }
  let mask: Buffer;
  try {
    mask = Buffer.from(maskB64, "base64");
  } catch {
    throw new Error("The segmentation worker returned a mask that is not valid base64.");
  }
  return {
    cls: det.cls,
    cls_id: det.cls_id,
    conf: det.conf,
    bbox: [bbox[0] as number, bbox[1] as number, bbox[2] as number, bbox[3] as number],
    area: det.area,
    mask: new Uint8Array(mask.buffer, mask.byteOffset, mask.byteLength),
  };
}

/** Worker errors name Python modules; translate the common ones into installs. */
function withHint(message: string): string {
  if (/No module named ['"]?(ultralytics|torch|cv2)/.test(message)) {
    const missing = message.match(/No module named ['"]?(\w+)/)?.[1] ?? "ultralytics";
    return (
      `${message} Install it into the Python the app uses ` +
      `(DIFFUSION_STUDIO_PYTHON to override): python -m pip install ${missing === "cv2" ? "opencv-python" : missing}.`
    );
  }
  if (/CUDA (out of memory|OOM)|out of memory/i.test(message)) {
    return `${message} Close GPU-heavy apps and retry; the worker runs one model at a time and the next call restarts it.`;
  }
  return message;
}
