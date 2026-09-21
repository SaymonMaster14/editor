/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  addPathEntry,
  appExePath,
  BUNDLE_RELATIVE,
  currentBundlePath,
  pathHasEntry,
  removePathEntry,
  resolveWindowsStdio,
  rootForResources,
  squirrelRoot,
  stableBinDir,
  stableBootstrapPath,
  stableShimPath,
  versionDirs,
} from "./index";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "winpaths-"));
  tempDirs.push(dir);
  return dir;
}

/** A fake Squirrel root with version dirs, each optionally carrying a bundle. */
function fakeInstall(versions: Record<string, boolean>): string {
  const root = tempDir();
  for (const [version, withBundle] of Object.entries(versions)) {
    const dir = join(root, `app-${version}`);
    mkdirSync(join(dir, "resources", "cli"), { recursive: true });
    if (withBundle) writeFileSync(join(dir, BUNDLE_RELATIVE), "// bundle");
  }
  return root;
}

describe("install layout", () => {
  test("resolves the root from the environment and from resources", () => {
    expect(squirrelRoot({ LOCALAPPDATA: join("C:", "Users", "u", "AppData", "Local") })).toBe(
      join("C:", "Users", "u", "AppData", "Local", "DiffusionStudio"),
    );
    expect(squirrelRoot({})).toBeNull();
    const resources = join("C:", "root", "app-0.205.2", "resources");
    expect(rootForResources(resources)).toBe(join("C:", "root"));
  });

  test("points the GUI at the stable stub, never a version dir", () => {
    const root = join("C:", "root");
    expect(appExePath(root)).toBe(join(root, "Diffusion Studio.exe"));
    expect(appExePath(root)).not.toContain("app-");
    expect(stableBinDir(root)).toBe(join(root, "bin"));
    expect(stableShimPath(root)).toBe(join(root, "bin", "dapi.cmd"));
    expect(stableBootstrapPath(root)).toBe(join(root, "bin", "dapi.js"));
  });

  test("orders version dirs newest-first, numerically", () => {
    const root = fakeInstall({ "0.205.2": true, "0.205.10": true, "0.19.0": true });
    expect(versionDirs(root)).toEqual(["app-0.205.10", "app-0.205.2", "app-0.19.0"]);
  });

  test("ignores non-version entries and a missing root", () => {
    const root = tempDir();
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "Update.exe"), "x");
    expect(versionDirs(root)).toEqual([]);
    expect(versionDirs(join(root, "nope"))).toEqual([]);
  });

  test("picks the newest version that actually carries a bundle", () => {
    const root = fakeInstall({ "0.205.2": true, "0.205.3": false });
    expect(currentBundlePath(root)).toBe(join(root, "app-0.205.2", BUNDLE_RELATIVE));
  });

  test("returns null when no version carries a bundle", () => {
    expect(currentBundlePath(fakeInstall({ "0.205.3": false }))).toBeNull();
    expect(currentBundlePath(tempDir())).toBeNull();
  });
});

describe("resolveWindowsStdio", () => {
  test("packaged: the stable stub on the current bundle, in node mode", () => {
    const root = fakeInstall({ "0.205.2": true });
    const exe = join(root, "Diffusion Studio.exe");
    writeFileSync(exe, "stub");
    const target = resolveWindowsStdio({
      isPackaged: true,
      resourcesPath: join(root, "app-0.205.2", "resources"),
      appPath: join(root, "app-0.205.2", "resources", "app.asar"),
    });
    expect(target).toEqual({
      command: exe,
      args: [join(root, "app-0.205.2", BUNDLE_RELATIVE), "mcp"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  test("packaged: null when the stub or every bundle is missing", () => {
    const root = fakeInstall({ "0.205.2": true });
    const resources = join(root, "app-0.205.2", "resources");
    expect(resolveWindowsStdio({ isPackaged: true, resourcesPath: resources, appPath: resources })).toBeNull();
    writeFileSync(join(root, "Diffusion Studio.exe"), "stub");
    rmSync(join(root, "app-0.205.2", BUNDLE_RELATIVE));
    expect(resolveWindowsStdio({ isPackaged: true, resourcesPath: resources, appPath: resources })).toBeNull();
  });

  test("dev: the workspace electron on the workspace bundle", () => {
    const repo = tempDir();
    const appPath = join(repo, "apps", "desktop");
    const electron = join(repo, "node_modules", "electron", "dist", "electron.exe");
    const bundle = join(repo, "apps", "cli", "dist", "index.js");
    mkdirSync(join(repo, "node_modules", "electron", "dist"), { recursive: true });
    mkdirSync(join(repo, "apps", "cli", "dist"), { recursive: true });
    writeFileSync(electron, "exe");
    writeFileSync(bundle, "// cli");
    const target = resolveWindowsStdio({ isPackaged: false, resourcesPath: "", appPath });
    expect(target).toEqual({ command: electron, args: [bundle, "mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    rmSync(bundle);
    expect(resolveWindowsStdio({ isPackaged: false, resourcesPath: "", appPath })).toBeNull();
  });
});

describe("user PATH entries", () => {
  const BIN = join("C:", "root", "bin");
  const OTHER = "C:\\other\\bin";

  test("detects an entry despite case and trailing slashes", () => {
    expect(pathHasEntry(`${OTHER};c:\\ROOT\\bin\\`, BIN)).toBe(true);
    expect(pathHasEntry(OTHER, BIN)).toBe(false);
    expect(pathHasEntry(null, BIN)).toBe(false);
  });

  test("adds once and keeps the rest byte-identical", () => {
    expect(addPathEntry(`${OTHER};`, BIN)).toBe(`${OTHER};${BIN}`);
    expect(addPathEntry(null, BIN)).toBe(BIN);
    expect(addPathEntry(`${OTHER};${BIN}`, BIN)).toBe(`${OTHER};${BIN}`);
    expect(addPathEntry(`c:\\root\\BIN;${OTHER}`, BIN)).toBe(`c:\\root\\BIN;${OTHER}`);
  });

  test("removes every spelling and nothing else", () => {
    expect(removePathEntry(`${OTHER};${BIN};C:\\third`, BIN)).toBe(`${OTHER};C:\\third`);
    expect(removePathEntry(`${BIN};c:\\ROOT\\bin\\;${OTHER}`, BIN)).toBe(OTHER);
    expect(removePathEntry(OTHER, BIN)).toBe(OTHER);
    expect(removePathEntry(null, BIN)).toBe("");
  });
});
