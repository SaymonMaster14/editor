/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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
  const stub = join(appData, "Diffusion Studio", "Diffusion Studio.exe");

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
});
