/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Buffer } from "node:buffer";
import { join } from "node:path";
import { ModelWorker, resolveWorkerPython, workerPaths } from "./model-worker";

import type { PythonProbe } from "./model-worker";
import type { WorkerPathsInput } from "./model-worker";
import type { ModelWorkerDeps } from "./model-worker";
import type { DepthWorkerResult } from "@diffusionstudio/dapi";

/**
 * The depth worker: a ModelWorker speaking workers/depth.py's protocol
 * (info/depth/shutdown over Depth-Anything-V2-Small). Same lifecycle as
 * segmentation — one persistent child, serialized calls, lazy restart —
 * with its own imports, weights home, and response parsing.
 */

/** The interpreter must import all of these for depth to run. */
export const DEPTH_IMPORTS = ["transformers", "torch", "cv2"];

export function resolveDepthPython(env?: NodeJS.ProcessEnv, probe?: PythonProbe): string[] | null {
  return resolveWorkerPython(DEPTH_IMPORTS, env, probe);
}

export function depthPaths(input: WorkerPathsInput): { scriptPath: string; modelsDir: string } {
  return workerPaths(input, "depth.py");
}

export type DepthWorkerDeps = Omit<ModelWorkerDeps, "extraEnv">;

export class DepthWorker extends ModelWorker {
  constructor(deps: DepthWorkerDeps) {
    super({
      ...deps,
      extraEnv: {
        // The HuggingFace cache (weights) lives inside our models dir,
        // not the user's global ~/.cache/huggingface.
        HF_HOME: join(deps.modelsDir, "hf"),
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

  /** Model id and device — also a cheap health check. */
  async info(): Promise<{ model: string; device: string }> {
    const res = await this.call({ cmd: "info" });
    if (typeof res.model !== "string" || typeof res.device !== "string") {
      throw new Error("The depth worker answered info with a shape this app cannot read.");
    }
    return { model: res.model, device: res.device };
  }

  async depth(png: Uint8Array): Promise<DepthWorkerResult> {
    const res = await this.call({ cmd: "depth", image_b64: Buffer.from(png).toString("base64") });
    return parseDepthResult(res);
  }
}

function parseDepthResult(res: Record<string, unknown>): DepthWorkerResult {
  const { width, height, device, ms, dmin, dmax, depth_b64 } = res;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof device !== "string" ||
    typeof dmin !== "number" ||
    typeof dmax !== "number" ||
    typeof depth_b64 !== "string"
  ) {
    throw new Error("The depth worker answered depth with a shape this app cannot read.");
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(depth_b64, "base64");
  } catch {
    throw new Error("The depth worker returned a depth map that is not valid base64.");
  }
  return {
    width,
    height,
    device,
    ms: typeof ms === "number" ? ms : 0,
    dmin,
    dmax,
    depth: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
  };
}

/** Worker errors name Python modules; translate the common ones into installs. */
function withHint(message: string): string {
  if (/No module named ['"]?(transformers|torch|cv2|timm|huggingface_hub)/.test(message)) {
    const missing = message.match(/No module named ['"]?(\w+)/)?.[1] ?? "transformers";
    const packageName = missing === "cv2" ? "opencv-python" : missing === "huggingface_hub" ? "huggingface-hub" : missing;
    return (
      `${message} Install it into the Python the app uses ` +
      `(DIFFUSION_STUDIO_PYTHON to override): python -m pip install ${packageName}.`
    );
  }
  if (/CUDA (out of memory|OOM)|out of memory/i.test(message)) {
    return `${message} Close GPU-heavy apps and retry; the worker runs one model at a time and the next call restarts it.`;
  }
  return message;
}
