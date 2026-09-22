/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ChildProcess } from "node:child_process";

/**
 * The shared transport for the main-process Python model workers
 * (segmentation, depth, …): one persistent stdio child per worker, NDJSON
 * requests with id correlation, strictly serialized calls, lazy restart
 * after a crash, and a shutdown-then-kill stop. Workers differ only in
 * their script, their Python imports, and how callers parse responses —
 * everything about owning the child lives here.
 */

export type PythonProbe = (command: string, args: string[]) => boolean;

/** A probe that passes only when the interpreter imports every module. */
export function importProbe(imports: string[]): PythonProbe {
  const snippet = `import ${imports.join(", ")}`;
  return (command, args) => {
    try {
      const probed = spawnSync(command, [...args, "-c", snippet], { stdio: "ignore", windowsHide: true });
      return probed.status === 0;
    } catch {
      return false;
    }
  };
}

/**
 * Ordered Python candidates: the explicit override first, then the
 * Windows `py` launcher, then bare names. Returns the command plus any
 * fixed leading args (e.g. ["py", "-3"]) for the first interpreter that
 * can actually run the worker — a bare interpreter that merely exists is
 * skipped, not picked. Null when none qualifies; an override that cannot
 * run the worker throws instead of silently falling through.
 */
export function resolveWorkerPython(
  imports: string[],
  env: NodeJS.ProcessEnv = process.env,
  probe: PythonProbe = importProbe(imports),
): string[] | null {
  const override = env.DIFFUSION_STUDIO_PYTHON?.trim();
  if (override) {
    if (!probe(override, [])) {
      throw new Error(
        `DIFFUSION_STUDIO_PYTHON points at ${override}, which cannot run this worker. ` +
          `Install its packages there (python -m pip install ${imports.join(" ")}) or unset it.`,
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

export type WorkerPathsInput = {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  userData: string;
};

/** Where a worker script ships and where its weights live, dev and packaged. */
export function workerPaths(input: WorkerPathsInput, scriptFile: string): { scriptPath: string; modelsDir: string } {
  return {
    scriptPath: input.isPackaged
      ? join(input.resourcesPath, "workers", scriptFile)
      : join(input.appPath, "workers", scriptFile),
    modelsDir: join(input.userData, "models"),
  };
}

export type ModelWorkerDeps = {
  /** Resolved python command plus fixed args; see resolveWorkerPython. */
  python: string[];
  scriptPath: string;
  modelsDir: string;
  /** Extra environment for the child (model-home overrides …). */
  extraEnv?: Record<string, string>;
  spawnFn?: typeof spawn;
  /** Lifecycle notes and skipped stdout go here; silent by default. */
  log?: (message: string) => void;
};

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export class ModelWorker {
  protected readonly deps: ModelWorkerDeps;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private stderrTail = "";
  private startPromise: Promise<void> | null = null;
  /** Calls strictly serialize: one in flight, the rest chained behind it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ModelWorkerDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** One request/response round trip; rejects when the worker answers ok:false. */
  call(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = this.queue.then(() => this.roundTrip(request));
    // A rejection must not wedge the queue for later calls.
    this.queue = run.catch(() => undefined);
    return run;
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
    for (const { reject } of waiting) reject(new Error("The model worker was stopped."));
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

  private async roundTrip(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    const id = this.nextId++;
    const child = this.child;
    if (!child?.stdin || !child.stdout) throw new Error("The model worker is not running.");
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
    if (!command) throw new Error("No Python command was configured for the model worker.");
    await mkdir(this.deps.modelsDir, { recursive: true });
    const spawnFn = this.deps.spawnFn ?? spawn;
    const child = spawnFn(command, [...fixedArgs, this.deps.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...this.deps.extraEnv,
        // Plain UTF-8 stdio on Windows: no code-page mojibake in errors.
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });
    this.deps.log?.(`[model-worker] spawned ${command} ${this.deps.scriptPath}`);
    this.child = child;
    this.buffer = "";
    this.stderrTail = "";
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.once("error", (error) => {
      this.deps.log?.(`[model-worker] spawn failed: ${(error as Error).message}`);
      this.onExit(`Could not start the model worker (${command}): ${(error as Error).message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return; // stop() already cleared it
      this.onExit(
        `The model worker exited${code === null ? ` on ${signal}` : ` with code ${code}`}` +
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
        this.deps.log?.(`[model-worker] non-JSON stdout: ${line.slice(0, 200)}`);
        continue;
      }
      const id = res.id;
      const pending = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!pending) continue;
      this.pending.delete(id as number);
      if (res.ok === true) pending.resolve(res);
      else pending.reject(new Error(typeof res.error === "string" ? res.error : "The model worker failed."));
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
