/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ArtifactStore } from "./artifact";
import type { ArtifactSpec } from "./artifact";

const spec = (overrides?: Partial<ArtifactSpec>): ArtifactSpec => ({
  kind: "scene-cuts",
  sourceHash: "source-1",
  parametersHash: "params-1",
  engine: "ffmpeg-select",
  engineVersion: "1.0.0",
  ...overrides,
});

async function withDirs(run: (projectDir: string, globalDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "analysis-artifact-"));
  try {
    await run(join(root, "project"), join(root, "global"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ArtifactStore", () => {
  it("misses before creation, hits after", async () => {
    await withDirs(async (projectDir) => {
      const store = new ArtifactStore({ projectDir });
      expect(await store.lookup(spec())).toBeNull();
      const created = await store.create(spec(), async (dir) => {
        await writeFile(join(dir, "cuts.json"), JSON.stringify([1.2, 3.4]), "utf8");
        return { dataPath: "cuts.json", metadata: { count: 2 } };
      });
      expect(created.id).toBe(ArtifactStore.keyFor(spec()));
      expect(created.metadata).toMatchObject({ count: 2 });
      const found = await store.lookup(spec());
      expect(found?.id).toBe(created.id);
      expect(found?.dataPath).toBe(created.dataPath);
    });
  });

  it("reuses identical specs and separates differing ones", async () => {
    await withDirs(async (projectDir) => {
      const store = new ArtifactStore({ projectDir });
      await store.create(spec(), async (dir) => {
        await writeFile(join(dir, "data.bin"), "x", "utf8");
        return { dataPath: "data.bin" };
      });
      expect(await store.lookup(spec())).not.toBeNull();
      expect(await store.lookup(spec({ parametersHash: "params-2" }))).toBeNull();
      expect(await store.lookup(spec({ engineVersion: "2.0.0" }))).toBeNull();
    });
  });

  it("skips corrupt manifests and cleans up failed creates", async () => {
    await withDirs(async (projectDir) => {
      const store = new ArtifactStore({ projectDir });
      await expect(
        store.create(spec(), async () => ({ dataPath: "never-written.json" })),
      ).rejects.toThrow(/missing/);
      expect(await store.lookup(spec())).toBeNull();
      expect(await store.list()).toEqual([]);
    });
  });

  it("rejects data paths that escape the artifact directory", async () => {
    await withDirs(async (projectDir) => {
      const store = new ArtifactStore({ projectDir });
      await expect(store.create(spec(), async () => ({ dataPath: "../evil.json" }))).rejects.toThrow(/escapes/);
    });
  });

  it("records and reports failures", async () => {
    await withDirs(async (projectDir) => {
      const store = new ArtifactStore({ projectDir });
      await store.recordFailure(spec(), new Error("cuda oom"));
      expect(await store.lookup(spec())).toBeNull();
      const failure = await store.failure(spec());
      expect(failure?.error).toBe("cuda oom");
      // A later success replaces the failure marker.
      await store.create(spec(), async (dir) => {
        await writeFile(join(dir, "d.json"), "{}", "utf8");
        return { dataPath: "d.json" };
      });
      expect(await store.lookup(spec())).not.toBeNull();
    });
  });

  it("invalidates by kind and lists what remains", async () => {
    await withDirs(async (projectDir) => {
      const store = new ArtifactStore({ projectDir });
      for (const kind of ["cuts", "depth"]) {
        await store.create(spec({ kind }), async (dir) => {
          await writeFile(join(dir, "d.json"), "{}", "utf8");
          return { dataPath: "d.json" };
        });
      }
      expect(await store.list()).toHaveLength(2);
      await store.invalidate("cuts");
      const remaining = await store.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.kind).toBe("depth");
      expect(await store.remove(spec({ kind: "depth" }))).toBe(true);
      expect(await store.remove(spec({ kind: "depth" }))).toBe(false);
      expect(await store.list()).toEqual([]);
    });
  });
});
