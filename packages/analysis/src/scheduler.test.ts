/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { JobCancelledError, JobTimeoutError, ResourceScheduler } from "./scheduler";

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("ResourceScheduler", () => {
  it("runs jobs and reports progress", async () => {
    const scheduler = new ResourceScheduler({ cpuConcurrency: 2 });
    const seen: number[] = [];
    const result = await scheduler.schedule({
      id: "a",
      run: async (_signal, report) => {
        report({ done: 1, total: 2 });
        report({ done: 2, total: 2 });
        return "ok";
      },
      onProgress: (progress) => seen.push(progress.done),
    });
    expect(result).toBe("ok");
    expect(seen).toEqual([1, 2]);
    expect(scheduler.info("a")?.state).toBe("done");
  });

  it("serializes GPU jobs by default", async () => {
    const scheduler = new ResourceScheduler();
    let active = 0;
    let peak = 0;
    const gpuJob = (id: string) =>
      scheduler.schedule({
        id,
        resources: ["gpu"],
        run: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick(20);
          active -= 1;
          return id;
        },
      });
    const results = await Promise.all([gpuJob("g1"), gpuJob("g2"), gpuJob("g3")]);
    expect(results.sort()).toEqual(["g1", "g2", "g3"]);
    expect(peak).toBe(1);
  });

  it("runs CPU jobs concurrently", async () => {
    const scheduler = new ResourceScheduler({ cpuConcurrency: 4 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      ["c1", "c2", "c3"].map((id) =>
        scheduler.schedule({
          id,
          resources: ["cpu"],
          run: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await tick(20);
            active -= 1;
          },
        }),
      ),
    );
    expect(peak).toBe(3);
  });

  it("cancels queued jobs and aborts running ones", async () => {
    const scheduler = new ResourceScheduler({ gpuConcurrency: 1 });
    const release = new Promise<void>((resolve) => setTimeout(resolve, 30));
    const first = scheduler.schedule({
      id: "first",
      resources: ["gpu"],
      run: async () => release.then(() => "first"),
    });
    const queued = scheduler.schedule({ id: "queued", resources: ["gpu"], run: async () => "never" });
    expect(scheduler.cancel("queued")).toBe(true);
    await expect(queued).rejects.toBeInstanceOf(JobCancelledError);
    await expect(first).resolves.toBe("first");

    let aborted = false;
    const running = scheduler.schedule({
      id: "running",
      run: async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        signal.throwIfAborted();
        return "unreached";
      },
    });
    await tick();
    expect(scheduler.cancel("running")).toBe(true);
    await expect(running).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("times out slow jobs", async () => {
    const scheduler = new ResourceScheduler();
    await expect(
      scheduler.schedule({
        id: "slow",
        timeoutMs: 15,
        run: async () => {
          await tick(150);
          return "late";
        },
      }),
    ).rejects.toBeInstanceOf(JobTimeoutError);
    expect(scheduler.info("slow")?.state).toBe("cancelled");
  });

  it("rejects duplicate ids and prunes finished jobs", async () => {
    const scheduler = new ResourceScheduler();
    const pending = scheduler.schedule({ id: "dup", run: async () => 1 });
    await expect(scheduler.schedule({ id: "dup", run: async () => 2 })).rejects.toThrow(/duplicate/);
    await pending;
    expect(scheduler.prune()).toBe(1);
    expect(scheduler.info("dup")).toBeNull();
  });
});
