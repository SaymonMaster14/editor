/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { guiEnv, isAppDown, launchApp, resolveWindowsExe } from "./cli-client";

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
