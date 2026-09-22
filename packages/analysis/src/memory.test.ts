/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { MemoryArtifactStore } from "./memory";
import { hashParamsAsync } from "./hash-core";

import type { ArtifactSpec } from "./artifact-spec";

async function spec(overrides?: Partial<ArtifactSpec>): Promise<ArtifactSpec> {
  return {
    kind: "scenes",
    sourceHash: "source-aaa",
    parametersHash: await hashParamsAsync({ threshold: 0.3 }),
    engine: "diffusion-scene",
    engineVersion: "1",
    ...overrides,
  };
}

describe("MemoryArtifactStore", () => {
  it("misses before create and hits after, with the stored data", async () => {
    const store = new MemoryArtifactStore();
    const key = await spec();
    await expect(store.lookup(key)).resolves.toBeNull();
    const created = await store.create(key, { cuts: [1.5] }, { note: "e2e" });
    expect(created.id).toBe(await MemoryArtifactStore.keyFor(key));
    expect(created.metadata).toEqual({ note: "e2e" });
    const hit = await store.lookup<{ cuts: number[] }>(key);
    expect(hit?.data).toEqual({ cuts: [1.5] });
    expect(store.stats()).toEqual({ entries: 1, hits: 1, misses: 1, failures: 0 });
  });

  it("misses when any key part changes", async () => {
    const store = new MemoryArtifactStore();
    await store.create(await spec(), { ok: true });
    await expect(store.lookup(await spec({ sourceHash: "other" }))).resolves.toBeNull();
    await expect(store.lookup(await spec({ parametersHash: "other" }))).resolves.toBeNull();
    await expect(store.lookup(await spec({ engineVersion: "2" }))).resolves.toBeNull();
  });

  it("keeps two kinds over the same bytes in separate slots", async () => {
    const store = new MemoryArtifactStore();
    const scenes = await spec({ kind: "scenes" });
    const beats = await spec({ kind: "beats" });
    expect(await MemoryArtifactStore.keyFor(scenes)).toBe(await MemoryArtifactStore.keyFor(beats));
    await store.create(scenes, { cuts: 1 });
    await store.create(beats, { bpm: 120 });
    expect((await store.lookup(scenes))?.data).toEqual({ cuts: 1 });
    expect((await store.lookup(beats))?.data).toEqual({ bpm: 120 });
  });

  it("evicts the oldest entries past the bound", async () => {
    const store = new MemoryArtifactStore({ maxEntries: 2 });
    const a = await spec({ sourceHash: "a" });
    const b = await spec({ sourceHash: "b" });
    const c = await spec({ sourceHash: "c" });
    await store.create(a, 1);
    await store.create(b, 2);
    await store.create(c, 3);
    await expect(store.lookup(a)).resolves.toBeNull();
    expect((await store.lookup(b))?.data).toBe(2);
    expect((await store.lookup(c))?.data).toBe(3);
    expect(store.stats().entries).toBe(2);
  });

  it("rejects a non-positive bound", () => {
    expect(() => new MemoryArtifactStore({ maxEntries: 0 })).toThrow(/maxEntries/);
  });

  it("records failures, skips them on lookup, and clears them on create", async () => {
    const store = new MemoryArtifactStore();
    const key = await spec();
    await store.recordFailure(key, new Error("decode exploded"));
    await expect(store.lookup(key)).resolves.toBeNull();
    expect((await store.failure(key))?.error).toBe("decode exploded");
    await store.create(key, { ok: true });
    expect((await store.lookup(key))?.data).toEqual({ ok: true });
    await expect(store.failure(key)).resolves.toBeNull();
  });

  it("removes and invalidates by kind", async () => {
    const store = new MemoryArtifactStore();
    const scenes = await spec({ kind: "scenes" });
    const beats = await spec({ kind: "beats" });
    await store.create(scenes, 1);
    await store.create(beats, 2);
    expect(await store.remove(scenes)).toBe(true);
    expect(await store.remove(scenes)).toBe(false);
    await store.create(scenes, 1);
    await store.invalidate("scenes");
    await expect(store.lookup(scenes)).resolves.toBeNull();
    expect((await store.lookup(beats))?.data).toBe(2);
    await store.invalidate();
    await expect(store.lookup(beats)).resolves.toBeNull();
    expect((await store.list()).length).toBe(0);
  });

  it("lists entries oldest first, optionally filtered", async () => {
    const store = new MemoryArtifactStore();
    await store.create(await spec({ kind: "scenes", sourceHash: "a" }), 1);
    await store.create(await spec({ kind: "beats", sourceHash: "b" }), 2);
    expect((await store.list()).map((e) => e.data)).toEqual([1, 2]);
    expect((await store.list("beats")).map((e) => e.data)).toEqual([2]);
  });
});
