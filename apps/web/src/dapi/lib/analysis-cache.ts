/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MemoryArtifactStore, hashBlobSampled, hashParamsAsync } from "@diffusionstudio/analysis";

// Session-scoped analysis cache for the DAPI handlers. The renderer has
// no filesystem, so this is the memory backend of the shared artifact
// machinery: identical source bytes + parameters + engine version reuse
// the stored result and skip decode entirely. A reload drops entries;
// the disk ArtifactStore stays the durable backend for node workers.
const store = new MemoryArtifactStore();

export type CachedAnalysis<T> = {
  result: T;
  /** True when the result came from the cache and `run` never executed. */
  cached: boolean;
};

export async function analyzeCached<T>(options: {
  kind: string;
  /** Engine id, e.g. "diffusion-scene". Bump `engineVersion` when it changes. */
  engine: string;
  engineVersion: string;
  /** Source bytes; hashed sampled (size + head/middle/tail), never decoded. */
  source: Blob;
  /** The logical parameters the result depends on; key order is ignored. */
  params: unknown;
  duration?: number;
  /** The expensive work: decode plus analysis. Skipped on a cache hit. */
  run: () => Promise<T>;
}): Promise<CachedAnalysis<T>> {
  const [sourceHash, parametersHash] = await Promise.all([hashBlobSampled(options.source), hashParamsAsync(options.params)]);
  const spec = {
    kind: options.kind,
    engine: options.engine,
    engineVersion: options.engineVersion,
    sourceHash,
    parametersHash,
    ...(options.duration !== undefined ? { duration: options.duration } : {}),
  };
  const hit = await store.lookup<T>(spec);
  if (hit) return { result: hit.data, cached: true };
  // Failures are not cached: a failed decode or analysis retries on the
  // next call instead of poisoning the slot.
  const result = await options.run();
  await store.create(spec, result);
  return { result, cached: false };
}

/** Cache counters for debugging and E2E assertions. */
export function analysisCacheStats(): { entries: number; hits: number; misses: number } {
  const { entries, hits, misses } = store.stats();
  return { entries, hits, misses };
}
