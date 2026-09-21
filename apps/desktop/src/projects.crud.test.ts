/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Project create/rename/duplicate/scan over fixture folders, including
// display names with spaces and Unicode, plus the Windows OneDrive/iCloud
// sync detection the storage layer must not regress.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { on: () => {} },
}));

const { cloudSyncKind, createProject, duplicateProject, getProject, renameProject, scanProjects } = await import("./projects");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "crud-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function packageOf(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
}

describe("createProject", () => {
  it("scaffolds a project whose folder is derived and display name kept", async () => {
    const project = await createProject(root, "My Video");
    expect(project.dir).toBe(join(root, "my-video"));
    expect(project.displayName).toBe("My Video");
    expect((await packageOf(project.dir)).displayName).toBe("My Video");
    const found = await getProject(project.dir);
    expect(found?.id).toBe(project.id);
    expect(found?.entry).toBeTruthy();
  });

  it("keeps Unicode display names verbatim while the folder stays safe", async () => {
    const project = await createProject(root, "Projeto Ç Final");
    expect(project.displayName).toBe("Projeto Ç Final");
    expect((await packageOf(project.dir)).displayName).toBe("Projeto Ç Final");
    expect(await getProject(project.dir)).not.toBeNull();
  });

  it("suffixes the folder when the name is taken", async () => {
    const first = await createProject(root, "Same Name");
    const second = await createProject(root, "Same Name");
    expect(first.dir).toBe(join(root, "same-name"));
    expect(second.dir).toBe(join(root, "same-name-2"));
    expect(second.id).not.toBe(first.id);
  });
});

describe("renameProject", () => {
  it("renames folder and record together while keeping the id", async () => {
    const before = await createProject(root, "Old Title");
    const after = await renameProject(before.dir, "New Title");
    expect(after.dir).toBe(join(root, "new-title"));
    expect(after.displayName).toBe("New Title");
    expect(after.id).toBe(before.id);
    expect((await packageOf(after.dir)).displayName).toBe("New Title");
    await expect(readdir(before.dir)).rejects.toThrow();
  });
});

describe("duplicateProject", () => {
  it("copies the folder with a fresh id", async () => {
    const source = await createProject(root, "Original");
    const copy = await duplicateProject(source.dir);
    expect(copy.dir).toBe(join(root, `${source.name}-copy`));
    expect(copy.id).not.toBe(source.id);
    expect(copy.displayName).toBe(`${source.displayName} (Copy)`);
    expect(await getProject(copy.dir)).not.toBeNull();
    // The source still describes itself.
    expect((await getProject(source.dir))?.id).toBe(source.id);
  });
});

describe("scanProjects", () => {
  it("finds projects and skips plain folders, dot folders and node_modules", async () => {
    await createProject(root, "Alpha");
    await createProject(root, "Beta");
    await mkdir(join(root, "not-a-project"), { recursive: true });
    await mkdir(join(root, ".hidden"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    const found = await scanProjects(root);
    expect(found.map((p) => p.displayName).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("returns null for folders without an entry", async () => {
    const dir = join(root, "empty");
    await mkdir(dir, { recursive: true });
    expect(await getProject(dir)).toBeNull();
  });
});

describe.runIf(process.platform === "win32")("cloudSyncKind on Windows", () => {
  const keys = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("names OneDrive roots from the environment and leaves plain disk alone", async () => {
    const drive = join(root, "OneDrive - X");
    const synced = join(drive, "Videos", "p");
    await mkdir(synced, { recursive: true });
    process.env.OneDrive = drive;
    expect(await cloudSyncKind(synced)).toBe("OneDrive");
    expect(await cloudSyncKind(join(root, "Videos", "p"))).toBeNull();
  });
});
