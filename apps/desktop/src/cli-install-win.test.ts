/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { SHIM_SIGNATURE, winInstallCli, winUninstallCli, type WinCliEnv } from "./cli-install-win";

const testDir = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = join(testDir, "..", "staged-cli");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-install-win-"));
  tempDirs.push(dir);
  return dir;
}

type Fake = WinCliEnv & {
  userPath: string | null;
  writes: string[];
  found: string[];
  root: string;
  binDir: string;
  shim: string;
};

/** A packaged-layout fixture using the real staged launcher payload. */
function fake(overrides: Partial<WinCliEnv> = {}): Fake {
  const root = tempDir();
  const resources = join(root, "app-0.205.2", "resources");
  mkdirSync(join(resources, "cli", "bin"), { recursive: true });
  copyFileSync(join(PAYLOAD, "dapi.cmd"), join(resources, "cli", "bin", "dapi.cmd"));
  copyFileSync(join(PAYLOAD, "dapi.js"), join(resources, "cli", "bin", "dapi.js"));
  const mutable = {
    userPath: `C:\\other\\bin` as string | null,
    writes: [] as string[],
    found: [] as string[],
  };
  const env = {
    isPackaged: true,
    resourcesPath: resources,
    root,
    binDir: join(root, "bin"),
    shim: join(root, "bin", "dapi.cmd"),
    readUserPath: () => mutable.userPath,
    writeUserPath: (value: string) => {
      mutable.writes.push(value);
      mutable.userPath = value;
    },
    whereDapi: () => mutable.found,
    ...overrides,
  };
  return Object.assign(mutable, env);
}

describe("winCliStatus", () => {
  test("reports installed only when the shim is present and on PATH", async () => {
    const { winCliStatus } = await import("./cli-install-win");
    const env = fake();
    expect(winCliStatus(env).installed).toBe(false);
    expect(winInstallCli(env)).toEqual({ status: "installed" });
    env.found = [env.shim];
    const status = winCliStatus(env);
    expect(status).toEqual({ installed: true, path: env.shim, managed: true, available: true });
  });
});

describe("winInstallCli", () => {
  test("copies the launcher and adds the stable bin to the user PATH", () => {
    const env = fake();
    expect(winInstallCli(env)).toEqual({ status: "installed" });
    expect(readFileSync(env.shim, "utf8")).toContain(SHIM_SIGNATURE);
    expect(env.writes).toHaveLength(1);
    expect(env.userPath).toBe(`C:\\other\\bin;${env.binDir}`);
  });

  test("is idempotent: files refresh, PATH is written once", () => {
    const env = fake();
    expect(winInstallCli(env)).toEqual({ status: "installed" });
    env.found = [env.shim];
    expect(winInstallCli(env)).toEqual({ status: "installed" });
    expect(env.writes).toHaveLength(1);
  });

  test("refuses to overwrite a shim it did not write", () => {
    const env = fake();
    mkdirSync(env.binDir, { recursive: true });
    writeFileSync(env.shim, "@echo off\necho foreign\n");
    expect(winInstallCli(env).status).toBe("error");
    expect(readFileSync(env.shim, "utf8")).toContain("foreign");
    expect(env.writes).toHaveLength(0);
  });

  test("refuses when another dapi is already on PATH", () => {
    const env = fake();
    env.found = ["C:\\tools\\dapi.cmd", env.shim];
    const result = winInstallCli(env);
    expect(result.status).toBe("error");
    expect(env.writes).toHaveLength(0);
  });

  test("rejects dev installs, missing payload, and an unreadable PATH", () => {
    expect(winInstallCli(fake({ isPackaged: false })).status).toBe("error");
    const missing = fake();
    rmSync(join(missing.resourcesPath, "cli"), { recursive: true, force: true });
    expect(winInstallCli(missing).status).toBe("error");
    const unreadable = fake();
    unreadable.userPath = null;
    expect(winInstallCli(unreadable).status).toBe("error");
  });
});

describe("winUninstallCli", () => {
  test("removes its files and its PATH entry, keeping the rest", () => {
    const env = fake();
    expect(winInstallCli(env)).toEqual({ status: "installed" });
    expect(winUninstallCli(env)).toEqual({ status: "removed" });
    expect(env.userPath).toBe("C:\\other\\bin");
    expect(env.writes).toHaveLength(2);
  });

  test("is idempotent and cleans a PATH entry whose files are already gone", () => {
    const env = fake();
    expect(winUninstallCli(env)).toEqual({ status: "absent" });
    env.userPath = `C:\\other\\bin;${env.binDir}`;
    expect(winUninstallCli(env)).toEqual({ status: "removed" });
    expect(env.userPath).toBe("C:\\other\\bin");
  });

  test("leaves a foreign shim and its PATH entry alone", () => {
    const env = fake();
    mkdirSync(env.binDir, { recursive: true });
    writeFileSync(env.shim, "@echo off\necho foreign\n");
    env.userPath = `C:\\other\\bin;${env.binDir}`;
    expect(winUninstallCli(env).status).toBe("error");
    expect(readFileSync(env.shim, "utf8")).toContain("foreign");
    expect(env.userPath).toContain(env.binDir);
  });

  test("drops the bin dir when empty, keeps it when something else lives there", () => {
    const env = fake();
    expect(winInstallCli(env)).toEqual({ status: "installed" });
    writeFileSync(join(env.binDir, "notes.txt"), "mine");
    expect(winUninstallCli(env)).toEqual({ status: "removed" });
    expect(readFileSync(join(env.binDir, "notes.txt"), "utf8")).toBe("mine");

    const clean = fake();
    expect(winInstallCli(clean)).toEqual({ status: "installed" });
    expect(winUninstallCli(clean)).toEqual({ status: "removed" });
    expect(() => readdirSync(clean.binDir)).toThrow();
  });
});
