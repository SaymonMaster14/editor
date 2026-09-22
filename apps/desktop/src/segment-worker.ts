/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ChildProcess } from "node:child_process";
import type { SegmentWorkerDetection, SegmentWorkerResult } from "@diffusionstudio/dapi";

/**
 * The main-process side of the segmentation worker: a persistent
 * `workers/segment.py` child speaking NDJSON over stdio. One worker per
 * app, calls serialized — the GPU holds a single model and concurrent
 * segment calls would just contend for it. Idle it keeps the model
 * resident (fork cost beats VRAM thrift at YOLO11n's ~50 MB); `stop()`
 * on quit unloads it.
 */

export type PythonProbe = (command: string, args: string[]) => boolean;

/** The worker's imports: an interpreter counts only when it runs them. */
const WORKER_IMPORTS = "import ultralytics, cv2, torch";

const defaultProbe: PythonProbe = (command, args) => {
  try {
    const probed = spawnSync(command, [...args, "-c", WORKER_IMPORTS], { stdio: "ignore", windowsHide: true });
    return probed.status === 0;
  } catch {
    return false;
  }
};

/**
 * Ordered Python candidates: the explicit override first, then the
 * Windows `py` launcher, then bare names. Returns the command plus any
 * fixed leading args (e.g. ["py", "-3"]) for the first interpreter that
 * can actually run the worker (ultralytics + cv2 + torch) — a bare
 * interpreter that merely exists is skipped, not picked. Null when none
 * qualifies.
 */
export function resolvePython(env: NodeJS.ProcessEnv = process.env, probe: PythonProbe = defaultProbe): string[] | null {
  const override = env.DIFFUSION_STUDIO_PYTHON?.trim();
  if (override) {
    if (!probe(override, [])) {
      throw new Error(
        `DIFFUSION_STUDIO_PYTHON points at ${override}, which cannot run the segmentation worker. ` +
          `Install the worker's packages there (python -m pip install ultralytics opencv-python torch) or unset it.`,
      );
    }
    return [override];
  }
  const candidates: string[][] = [...(process.platform === "win32" ? [["py", "-3"]] : []), ["python"], ["python3"]];
  for (const [command, ...args] of candidates) {
    if (command && probe(command, args)) return [command, ...args];
  }
  return null;
}

export type SegmentPathsInput = {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  userData: string;
};

/** Where the worker script ships and where its weights live, dev and packaged. */
export function segmentPaths(input: SegmentPathsInput): { scriptPath: string; modelsDir: string } {
  return {
    scriptPath: input.isPackaged
      ? join(input.resourcesPath, "workers", "segment.py")
      : join(input.appPath, "workers", "segment.py"),
    modelsDir: join(input.userData, "models"),
  };
}

export type SegmentCallOptions = {
  classes?: string[];
  conf?: number;
};

export type SegmentWorkerDeps = {
  /** Resolved python command plus fixed args; see resolvePython. */
  python: string[];
  scriptPath: string;
  modelsDir: string;
  spawnFn?: typeof spawn;
  /** Stderr lines and lifecycle notes go here; silent by default. */
  log?: (message: string) => void;
};

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export class SegmentWorker {
  private readonly deps: SegmentWorkerDeps;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private stderrTail = "";
  private startPromise: Promise<void> | null = null;
  /** Calls strictly serialize: one in flight, the rest chained behind it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SegmentWorkerDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.child !== null;
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

  /** Ask the worker to exit, then kill it if it lingers. Safe to call twice. */
  async stop(timeoutMs = 5000): Promise<void> {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    // In-flight calls fail here: the exit below is stop-initiated, so the
    // exit handler stays quiet and must not double-report them.
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(new Error("The segmentation worker was stopped."));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    try {
      child.stdin?.write(JSON.stringify({ id: 0, cmd: "shutdown" }) + "\n");
    } catch {
      // Already gone; the exit below still fires.
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }

  private call(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = this.queue.then(() => this.roundTrip(request));
    // A rejection must not wedge the queue for later calls.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async roundTrip(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    const id = this.nextId++;
    const child = this.child;
    if (!child?.stdin || !child.stdout) throw new Error("The segmentation worker is not running.");
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    child.stdin.write(JSON.stringify({ ...request, id }) + "\n");
    return promise;
  }

  private ensureStarted(): Promise<void> {
    this.startPromise ??= this.start();
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const [command, ...fixedArgs] = this.deps.python;
    if (!command) throw new Error("No Python command was configured for the segmentation worker.");
    await mkdir(this.deps.modelsDir, { recursive: true });
    const spawnFn = this.deps.spawnFn ?? spawn;
    const child = spawnFn(command, [...fixedArgs, this.deps.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        // Weights and settings stay inside our models dir, not the
        // user's global Ultralytics config.
        YOLO_CONFIG_DIR: this.deps.modelsDir,
        ULTRALYTICS_SETTINGS_DIR: this.deps.modelsDir,
        // Plain UTF-8 stdio on Windows: no code-page mojibake in errors.
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });
    this.deps.log?.(`[segment] spawned ${command} ${this.deps.scriptPath}`);
    this.child = child;
    this.buffer = "";
    this.stderrTail = "";
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.once("error", (error) => {
      this.deps.log?.(`[segment] spawn failed: ${(error as Error).message}`);
      this.onExit(`Could not start the segmentation worker (${command}): ${(error as Error).message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return; // stop() already cleared it
      this.onExit(
        `The segmentation worker exited${code === null ? ` on ${signal}` : ` with code ${code}`}` +
          (this.stderrTail.trim() ? `: ${this.stderrTail.trim().split("\n").pop()}` : "."),
      );
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let res: Record<string, unknown>;
      try {
        res = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.deps.log?.(`[segment] non-JSON stdout: ${line.slice(0, 200)}`);
        continue;
      }
      const id = res.id;
      const pending = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!pending) continue;
      this.pending.delete(id as number);
      if (res.ok === true) pending.resolve(res);
      else pending.reject(new Error(typeof res.error === "string" ? withHint(res.error) : "The segmentation worker failed."));
    }
  }

  /** The child died: fail the in-flight call and clear for a lazy restart. */
  private onExit(message: string): void {
    this.child = null;
    this.startPromise = null;
    const error = new Error(message);
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(error);
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
