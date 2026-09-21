/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn as spawnMock } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});
import {
  FAIL_WATCHDOG_MS,
  appError,
  fail,
  failSync,
  guiEnv,
  isAppDown,
  launchApp,
  resolveWindowsExe,
} from "./cli-client";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("guiEnv", () => {
  test("strips the node-mode flag and keeps everything else", () => {
    const env = guiEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "C:\\bin", KEEP: "yes" });
    expect(env).toEqual({ PATH: "C:\\bin", KEEP: "yes" });
    expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
  });
});

describe("resolveWindowsExe", () => {
  const appData = join("C:", "Users", "u", "AppData", "Local");
  const stub = join(appData, "DiffusionStudio", "Diffusion Studio.exe");

  test("prefers the launcher-provided path when it exists", () => {
    const custom = join("D:", "apps", "Diffusion Studio.exe");
    expect(resolveWindowsExe({ DIFFUSION_APP_PATH: custom }, (p) => p === custom)).toBe(custom);
  });

  test("falls back to the stable Squirrel stub, never a version dir", () => {
    expect(resolveWindowsExe({ LOCALAPPDATA: appData }, (p) => p === stub)).toBe(stub);
    expect(stub).not.toContain("app-");
  });

  test("ignores a launcher path that does not exist and resolves nothing when absent", () => {
    expect(resolveWindowsExe({ DIFFUSION_APP_PATH: join("D:", "gone.exe") }, () => false)).toBeNull();
    expect(resolveWindowsExe({}, () => true)).toBeNull();
    expect(resolveWindowsExe({ LOCALAPPDATA: appData }, () => false)).toBeNull();
  });
});

describe("isAppDown", () => {
  test("recognizes refused and reset connections through the cause chain", () => {
    expect(isAppDown(new Error("x", { cause: { code: "ECONNREFUSED" } }))).toBe(true);
    expect(isAppDown({ cause: { cause: { code: "ECONNRESET" } } })).toBe(true);
    expect(isAppDown(new Error("boom"))).toBe(false);
    expect(isAppDown(null)).toBe(false);
  });
});

describe("failSync", () => {
  test("reports and exits synchronously for pre-connection usage errors", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    expect(() => failSync("File not found: C:\\gone.mp4")).toThrow("exited");
    expect(err).toHaveBeenCalledWith("File not found: C:\\gone.mp4");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("fail", () => {
  test("reports, arms exit code 1, and never exits synchronously", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const race = Promise.race([
      fail("No project open").then(() => "settled"),
      new Promise((r) => setTimeout(() => r("parked"), 20)),
    ]);
    await vi.advanceTimersByTimeAsync(20);
    expect(err).toHaveBeenCalledWith("No project open");
    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    await expect(race).resolves.toBe("parked");
  });

  test("forces the exit when the loop stays alive past the watchdog", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    void fail("boom");
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FAIL_WATCHDOG_MS);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("appError", () => {
  test("maps app-down to the launch hint and other errors to their message", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const down = new Error("x", { cause: { code: "ECONNREFUSED" } });
    void appError(down).catch(() => {});
    void appError(new Error("kaboom")).catch(() => {});
    // Both park; flush the synchronous reporting.
    await Promise.resolve();
    expect(err).toHaveBeenCalledWith("Diffusion Studio is not running. Launch the app first, then retry.");
    expect(err).toHaveBeenCalledWith("kaboom");
    expect(process.exitCode).toBe(1);
  });
});

describe("launchApp", () => {
  test("resolves false when no Windows install exists", async () => {
    if (process.platform !== "win32") return;
    // Nothing installed under a scratch LOCALAPPDATA, so there is nothing to start.
    const env = { ...process.env, LOCALAPPDATA: join("C:", "no-such-dir"), DIFFUSION_APP_PATH: "" };
    const realEnv = process.env;
    process.env = env;
    try {
      await expect(launchApp(false)).resolves.toBe(false);
    } finally {
      process.env = realEnv;
    }
  });

  function mockSpawn(outcome: "spawn" | "error"): { spawn: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> } {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    process.nextTick(() => child.emit(outcome, outcome === "error" ? new Error("ENOENT") : undefined));
    const spawn = vi.mocked(spawnMock);
    spawn.mockClear();
    spawn.mockReturnValue(child as never);
    return { spawn, unref: child.unref };
  }

  function withInstalledExe<T>(run: () => Promise<T>): Promise<T> {
    // A real file so resolveWindowsExe accepts it; spawn itself is mocked.
    const realEnv = process.env;
    process.env = { ...realEnv, DIFFUSION_APP_PATH: process.execPath, ELECTRON_RUN_AS_NODE: "1" };
    return run().finally(() => {
      process.env = realEnv;
    });
  }

  test("spawns the GUI detached with ignored stdio and a sanitized env", async () => {
    if (process.platform !== "win32") return;
    const { spawn, unref } = mockSpawn("spawn");
    await withInstalledExe(async () => {
      await expect(launchApp(false)).resolves.toBe(true);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [exe, args, options] = spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(exe).toBe(process.execPath);
    expect(args).toEqual([]);
    // Piped stdio would be inherited by the Squirrel stub's re-exec chain and
    // keep this CLI (and any upstream pipe consumer) from ever draining.
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    // No windowsHide: a SW_HIDE show-state inherited by the first instance
    // breaks its first second-instance delivery (later `dapi open` would not
    // surface until attempted twice); --hidden argv is the hiding mechanism.
    expect(options.windowsHide ?? false).toBe(false);
    expect("ELECTRON_RUN_AS_NODE" in (options.env as object)).toBe(false);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("passes --hidden for background launch and reports spawn errors as false", async () => {
    if (process.platform !== "win32") return;
    const { spawn } = mockSpawn("error");
    await withInstalledExe(async () => {
      await expect(launchApp(true)).resolves.toBe(false);
    });
    const [, args] = spawn.mock.calls[0] as [string, string[]];
    expect(args).toEqual(["--hidden"]);
  });
});
