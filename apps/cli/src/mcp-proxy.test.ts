/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, test, vi } from "vitest";
import { FAIL_WATCHDOG_MS } from "./cli-client";
import { resetShutdownForTest, shutdown } from "./mcp-proxy";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  resetShutdownForTest();
});

function closable(fails = false): { close: () => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    close: async () => {
      calls++;
      if (fails) throw new Error("already gone");
    },
  };
}

describe("shutdown", () => {
  test("arms the code, closes peers best-effort, never exits synchronously", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const ok = closable();
    const broken = closable(true);
    shutdown(1, [ok, broken]);
    await vi.advanceTimersByTimeAsync(0);
    expect(process.exitCode).toBe(1);
    expect(ok.calls()).toBe(1);
    expect(broken.calls()).toBe(1);
    expect(exit).not.toHaveBeenCalled();
  });

  test("first shutdown wins; later ones are ignored", () => {
    vi.useFakeTimers();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const first = closable();
    const second = closable();
    shutdown(1, [first]);
    shutdown(0, [second]);
    expect(process.exitCode).toBe(1);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
  });

  test("watchdog forces the exit when the loop stays alive", () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    shutdown(0, []);
    vi.advanceTimersByTime(FAIL_WATCHDOG_MS);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
