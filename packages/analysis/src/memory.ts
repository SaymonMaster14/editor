/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// In-memory analysis artifacts for contexts without a filesystem — the
// DAPI handlers running in the renderer. Same lifecycle as the disk
// ArtifactStore (spec → cache key → lookup/create, failure records,
// invalidation), same key scheme (the ids are interchangeable), but the
// data value is held inline instead of a data file. Entries are
// session-scoped: a reload drops them, and the disk store remains the
// durable backend for node-side workers. Bounded: past `maxEntries`
// the oldest entries are evicted first.

import { cacheKeyAsync } from "./hash-core";

import type { ArtifactSpec, FailureRecord } from "./artifact-spec";

export type MemoryArtifact<T = unknown> = {
  /** The cache key: stable for identical source + params + engine. */
  id: string;
  kind: string;
  sourceHash: string;
  parametersHash: string;
  engine: string;
  engineVersion: string;
  createdAt: string;
  duration?: number;
  fps?: number;
  metadata: Record<string, unknown>;
  /** The stored analysis result, held inline. */
  data: T;
};

export type MemoryStoreStats = {
  entries: number;
  hits: number;
  misses: number;
  failures: number;
};

const DEFAULT_MAX_ENTRIES = 200;

export class MemoryArtifactStore {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, MemoryArtifact>();
  private readonly failuresByKey = new Map<string, FailureRecord>();
  private hits = 0;
  private misses = 0;

  constructor(options?: { maxEntries?: number }) {
    const max = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(max) || max < 1) throw new Error(`memory store: maxEntries must be a positive integer, got ${max}`);
    this.maxEntries = max;
  }

  /** The cache key (artifact id) a spec would be stored under. */
  static keyFor(spec: ArtifactSpec): Promise<string> {
    return cacheKeyAsync(spec);
  }

  /**
   * The id hashes source + params + engine, not kind — like the disk
   * store's `<kind>/<id>` directories, slots are namespaced by kind so
   * two kinds over the same bytes never clobber each other.
   */
  private static async slotFor(spec: ArtifactSpec): Promise<string> {
    return `${spec.kind}\0${await MemoryArtifactStore.keyFor(spec)}`;
  }

  /**
   * The stored artifact for `spec`, or null. Entries recorded via
   * `recordFailure` are skipped unless `includeFailed` is set.
   */
  async lookup<T>(spec: ArtifactSpec, options?: { includeFailed?: boolean }): Promise<MemoryArtifact<T> | null> {
    const slot = await MemoryArtifactStore.slotFor(spec);
    if (!options?.includeFailed && this.failuresByKey.has(slot)) {
      this.misses += 1;
      return null;
    }
    const found = this.entries.get(slot);
    if (!found) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return found as MemoryArtifact<T>;
  }

  /**
   * Stores `data` for `spec`, replacing any previous entry and clearing
   * any recorded failure. Evicts the oldest entries past the bound.
   */
  async create<T>(spec: ArtifactSpec, data: T, metadata?: Record<string, unknown>): Promise<MemoryArtifact<T>> {
    const slot = await MemoryArtifactStore.slotFor(spec);
    const id = await MemoryArtifactStore.keyFor(spec);
    const artifact: MemoryArtifact<T> = {
      id,
      kind: spec.kind,
      sourceHash: spec.sourceHash,
      parametersHash: spec.parametersHash,
      engine: spec.engine,
      engineVersion: spec.engineVersion,
      createdAt: new Date().toISOString(),
      ...(spec.duration !== undefined ? { duration: spec.duration } : {}),
      ...(spec.fps !== undefined ? { fps: spec.fps } : {}),
      metadata: { ...(spec.metadata ?? {}), ...(metadata ?? {}) },
      data,
    };
    // Refresh insertion order so eviction drops the stalest entries.
    this.entries.delete(slot);
    this.entries.set(slot, artifact as MemoryArtifact);
    this.failuresByKey.delete(slot);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return artifact;
  }

  /** Records a failed run so repeat callers can see (and skip) it. */
  async recordFailure(spec: ArtifactSpec, error: unknown): Promise<void> {
    const slot = await MemoryArtifactStore.slotFor(spec);
    this.failuresByKey.set(slot, {
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
      spec,
    });
  }

  /** The failure record for `spec`, if one was recorded. */
  async failure(spec: ArtifactSpec): Promise<FailureRecord | null> {
    return this.failuresByKey.get(await MemoryArtifactStore.slotFor(spec)) ?? null;
  }

  /** Removes one artifact (or its failure record). */
  async remove(spec: ArtifactSpec): Promise<boolean> {
    const slot = await MemoryArtifactStore.slotFor(spec);
    const hadEntry = this.entries.delete(slot);
    const hadFailure = this.failuresByKey.delete(slot);
    return hadEntry || hadFailure;
  }

  /** Removes every artifact of `kind` (or everything). */
  async invalidate(kind?: string): Promise<void> {
    if (kind === undefined) {
      this.entries.clear();
      this.failuresByKey.clear();
      return;
    }
    for (const [id, entry] of this.entries) {
      if (entry.kind === kind) this.entries.delete(id);
    }
    for (const [id, record] of this.failuresByKey) {
      if (record.spec.kind === kind) this.failuresByKey.delete(id);
    }
  }

  /** Lists stored artifacts, optionally filtered by kind, oldest first. */
  async list<T>(kind?: string): Promise<Array<MemoryArtifact<T>>> {
    const out: Array<MemoryArtifact<T>> = [];
    for (const entry of this.entries.values()) {
      if (kind === undefined || entry.kind === kind) out.push(entry as MemoryArtifact<T>);
    }
    return out;
  }

  stats(): MemoryStoreStats {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses, failures: this.failuresByKey.size };
  }
}
