/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Buffer } from "node:buffer";
import { join } from "node:path";
import { ModelWorker, resolveWorkerPython, workerPaths } from "./model-worker";

import type { PythonProbe } from "./model-worker";
import type { WorkerPathsInput } from "./model-worker";
import type { ModelWorkerDeps } from "./model-worker";
import type { FlowWorkerResult } from "@diffusionstudio/dapi";

/**
 * The optical-flow worker: a ModelWorker speaking workers/flow.py's
 * protocol (info/flow/shutdown over DIS + RAFT-small). Same lifecycle as
 * segmentation and depth — one persistent child, serialized calls, lazy
 * restart — with its own imports, weights home, and response parsing.
 */

/** The interpreter must import all of these for flow to run. */
export const FLOW_IMPORTS = ["torch", "torchvision", "cv2"];

export function resolveFlowPython(env?: NodeJS.ProcessEnv, probe?: PythonProbe): string[] | null {
  return resolveWorkerPython(FLOW_IMPORTS, env, probe);
}

export function flowPaths(input: WorkerPathsInput): { scriptPath: string; modelsDir: string } {
  return workerPaths(input, "flow.py");
}

export type FlowWorkerDeps = Omit<ModelWorkerDeps, "extraEnv">;

export type FlowEngine = "dis" | "raft";

export class FlowWorker extends ModelWorker {
  constructor(deps: FlowWorkerDeps) {
    super({
      ...deps,
      extraEnv: {
        // The torchvision weights cache lives inside our models dir,
        // not the user's global ~/.cache/torch.
        TORCH_HOME: join(deps.modelsDir, "torch"),
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
  async info(): Promise<{ model: string; device: string; engines: string[] }> {
    const res = await this.call({ cmd: "info" });
    if (typeof res.model !== "string" || typeof res.device !== "string" || !Array.isArray(res.engines)) {
      throw new Error("The flow worker answered info with a shape this app cannot read.");
    }
    return { model: res.model, device: res.device, engines: res.engines as string[] };
  }

  async flow(pngA: Uint8Array, pngB: Uint8Array, engine: FlowEngine = "raft"): Promise<FlowWorkerResult> {
    const res = await this.call({
      cmd: "flow",
      image_a_b64: Buffer.from(pngA).toString("base64"),
      image_b_b64: Buffer.from(pngB).toString("base64"),
      engine,
    });
    return parseFlowResult(res);
  }
}

function parseFlowResult(res: Record<string, unknown>): FlowWorkerResult {
  const { width, height, device, engine, ms, mean_mag, p95_mag, flow_b64, preview_b64 } = res;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof device !== "string" ||
    (engine !== "dis" && engine !== "raft") ||
    typeof mean_mag !== "number" ||
    typeof p95_mag !== "number" ||
    typeof flow_b64 !== "string" ||
    typeof preview_b64 !== "string"
  ) {
    throw new Error("The flow worker answered flow with a shape this app cannot read.");
  }
  let raw: Buffer;
  let preview: Buffer;
  try {
    raw = Buffer.from(flow_b64, "base64");
    preview = Buffer.from(preview_b64, "base64");
  } catch {
    throw new Error("The flow worker returned a flow field or preview that is not valid base64.");
  }
  return {
    width,
    height,
    device,
    engine,
    ms: typeof ms === "number" ? ms : 0,
    meanMag: mean_mag,
    p95Mag: p95_mag,
    flow: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
    preview: new Uint8Array(preview.buffer, preview.byteOffset, preview.byteLength),
  };
}

/** Worker errors name Python modules; translate the common ones into installs. */
function withHint(message: string): string {
  if (/No module named ['"]?(torch|torchvision|cv2|numpy)/.test(message)) {
    const missing = message.match(/No module named ['"]?(\w+)/)?.[1] ?? "torch";
    const packageName = missing === "cv2" ? "opencv-python" : missing;
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
