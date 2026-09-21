/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Resource-aware job scheduling for media analysis. A job declares which
// resource classes it needs; the scheduler admits it once every class has
// a free slot. Heavy GPU work runs serially by default (one model in VRAM
// at a time on an 8 GB card); CPU work fans out to the core count; I/O and
// network are generous. Every job supports progress, cancellation via
// AbortSignal, and a timeout.

import { cpus } from "node:os";

export type ResourceClass = "cpu" | "gpu" | "io" | "net";

export type JobProgress = { done: number; total?: number; message?: string };

export type JobRun<T> = (signal: AbortSignal, report: (progress: JobProgress) => void) => Promise<T>;

export type JobSpec<T> = {
  id: string;
  /** Resource classes the job holds for its whole run. Default: ["cpu"]. */
  resources?: ResourceClass[];
  /** Heavyweight jobs run alone within their classes; default: resources include gpu. */
  run: JobRun<T>;
  /** Abort the job after this many ms. No timeout when omitted. */
  timeoutMs?: number;
  /** Progress listener; also mirrored to `progressOf`. */
  onProgress?: (progress: JobProgress) => void;
};

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export type JobInfo = {
  id: string;
  state: JobState;
  resources: ResourceClass[];
  progress: JobProgress | null;
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
};

export type SchedulerOptions = {
  /** Concurrent CPU jobs. Default: core count (min 2). */
  cpuConcurrency?: number;
  /** Concurrent GPU jobs. Default: 1 — one model in VRAM at a time. */
  gpuConcurrency?: number;
  ioConcurrency?: number;
  netConcurrency?: number;
};

export class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} was cancelled`);
    this.name = "JobCancelledError";
  }
}

export class JobTimeoutError extends Error {
  constructor(jobId: string, timeoutMs: number) {
    super(`job ${jobId} timed out after ${timeoutMs} ms`);
    this.name = "JobTimeoutError";
  }
}

type Entry<T> = {
  spec: JobSpec<T>;
  resources: ResourceClass[];
  state: JobState;
  progress: JobProgress | null;
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function defaultConcurrency(): Record<ResourceClass, number> {
  return { cpu: Math.max(2, cpus().length), gpu: 1, io: 16, net: 16 };
}

export class ResourceScheduler {
  private readonly capacity: Record<ResourceClass, number>;
  private readonly held: Record<ResourceClass, number> = { cpu: 0, gpu: 0, io: 0, net: 0 };
  private readonly queue: Entry<unknown>[] = [];
  private readonly jobs = new Map<string, Entry<unknown>>();
  private stopped = false;

  constructor(options?: SchedulerOptions) {
    const defaults = defaultConcurrency();
    this.capacity = {
      cpu: options?.cpuConcurrency ?? defaults.cpu,
      gpu: options?.gpuConcurrency ?? defaults.gpu,
      io: options?.ioConcurrency ?? defaults.io,
      net: options?.netConcurrency ?? defaults.net,
    };
  }

  /** Schedules a job; resolves/rejects with its outcome. Duplicate ids reject. */
  schedule<T>(spec: JobSpec<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("scheduler is stopped"));
    if (this.jobs.has(spec.id)) return Promise.reject(new Error(`duplicate job id ${JSON.stringify(spec.id)}`));
    const resources = spec.resources?.length ? [...spec.resources] : (["cpu"] as ResourceClass[]);
    return new Promise<T>((resolve, reject) => {
      const entry: Entry<unknown> = {
        spec: spec as JobSpec<unknown>,
        resources,
        state: "queued",
        progress: null,
        queuedAt: Date.now(),
        controller: new AbortController(),
        timer: null,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.jobs.set(spec.id, entry);
      this.queue.push(entry);
      this.pump();
    });
  }

  /** Cancels a queued or running job. Resolves true when it was pending. */
  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry || entry.state === "done" || entry.state === "failed" || entry.state === "cancelled") return false;
    entry.controller.abort(new JobCancelledError(jobId));
    if (entry.state === "queued") {
      entry.state = "cancelled";
      entry.finishedAt = Date.now();
      entry.error = new JobCancelledError(jobId).message;
      this.dequeue(entry);
      entry.reject(new JobCancelledError(jobId));
    }
    return true;
  }

  info(jobId: string): JobInfo | null {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    return {
      id: jobId,
      state: entry.state,
      resources: [...entry.resources],
      progress: entry.progress,
      ...(entry.error ? { error: entry.error } : {}),
      queuedAt: entry.queuedAt,
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
    };
  }

  /** Drops finished job records; running/queued ones are kept. */
  prune(): number {
    let dropped = 0;
    for (const [id, entry] of this.jobs) {
      if (entry.state === "done" || entry.state === "failed" || entry.state === "cancelled") {
        this.jobs.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Stops admission and cancels everything pending; running jobs see the abort. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const entry of [...this.queue]) this.cancel((entry.spec as JobSpec<unknown>).id);
    for (const entry of this.jobs.values()) {
      if (entry.state === "running") entry.controller.abort(new JobCancelledError((entry.spec as JobSpec<unknown>).id));
    }
  }

  stats(): { queued: number; running: number; held: Record<ResourceClass, number>; capacity: Record<ResourceClass, number> } {
    let queued = 0;
    let running = 0;
    for (const entry of this.jobs.values()) {
      if (entry.state === "queued") queued += 1;
      else if (entry.state === "running") running += 1;
    }
    return { queued, running, held: { ...this.held }, capacity: { ...this.capacity } };
  }

  private dequeue(entry: Entry<unknown>): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private canAdmit(entry: Entry<unknown>): boolean {
    return entry.resources.every((resource) => this.held[resource] < this.capacity[resource]);
  }

  private pump(): void {
    for (const entry of [...this.queue]) {
      if (!this.canAdmit(entry)) continue;
      this.dequeue(entry);
      void this.execute(entry);
    }
  }

  private async execute(entry: Entry<unknown>): Promise<void> {
    const id = (entry.spec as JobSpec<unknown>).id;
    for (const resource of entry.resources) this.held[resource] += 1;
    entry.state = "running";
    entry.startedAt = Date.now();
    const { signal } = entry.controller;
    if (entry.spec.timeoutMs !== undefined) {
      entry.timer = setTimeout(() => {
        entry.controller.abort(new JobTimeoutError(id, entry.spec.timeoutMs!));
      }, entry.spec.timeoutMs);
      entry.timer.unref?.();
    }
    const report = (progress: JobProgress): void => {
      entry.progress = progress;
      entry.spec.onProgress?.(progress);
    };
    try {
      if (signal.aborted) throw signal.reason ?? new JobCancelledError(id);
      const value = await entry.spec.run(signal, report);
      if (signal.aborted) throw signal.reason ?? new JobCancelledError(id);
      entry.state = "done";
      entry.finishedAt = Date.now();
      entry.resolve(value);
    } catch (error) {
      entry.state = signal.aborted && (signal.reason instanceof JobCancelledError || signal.reason instanceof JobTimeoutError) ? "cancelled" : "failed";
      if (entry.state === "cancelled" && signal.reason instanceof Error) entry.error = signal.reason.message;
      else entry.error = error instanceof Error ? error.message : String(error);
      // A timeout surfaces as the timeout error even when the job threw first.
      if (signal.reason instanceof JobTimeoutError) entry.error = signal.reason.message;
      entry.finishedAt = Date.now();
      entry.reject(signal.reason instanceof JobTimeoutError ? signal.reason : error);
    } finally {
      if (entry.timer) clearTimeout(entry.timer);
      for (const resource of entry.resources) this.held[resource] -= 1;
      this.pump();
    }
  }
}
