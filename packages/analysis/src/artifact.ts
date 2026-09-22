/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Disk-backed analysis artifacts. One analysis run — tracking, depth,
// scene cuts, beats — is identified by its cache key (source hash +
// parameter hash + engine id/version) and stored as a directory holding
// `artifact.json` plus whatever data files the engine wrote. Project
// artifacts live under the project so they travel with it; a global
// content-addressed cache deduplicates identical work across projects.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { cacheKey } from "./hash";

import type { ArtifactSpec, FailureRecord } from "./artifact-spec";

export type { ArtifactSpec, FailureRecord } from "./artifact-spec";

export type AnalysisArtifact = {
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
  /** Data file path, relative to the artifact directory. */
  dataPath: string;
  metadata: Record<string, unknown>;
};

export type ArtifactStoreOptions = {
  /** Project root: artifacts go under `<root>/analysis/`. */
  projectDir: string;
  /** Global dedup cache root (optional): `<root>/<kind>/<id>/`. */
  globalDir?: string;
};

const ARTIFACT_FILE = "artifact.json";
const FAILURE_FILE = "failed.json";
const TMP_SUFFIX = ".tmp";

function sanitizeSegment(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, "").slice(0, 64);
  if (!clean || clean === "." || clean === "..") throw new Error(`artifact: invalid path segment ${JSON.stringify(value)}`);
  return clean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export class ArtifactStore {
  private readonly projectDir: string;
  private readonly globalDir: string | null;

  constructor(options: ArtifactStoreOptions) {
    this.projectDir = options.projectDir;
    this.globalDir = options.globalDir ?? null;
  }

  /** The cache key (artifact id) a spec would be stored under. */
  static keyFor(spec: ArtifactSpec): string {
    return cacheKey(spec);
  }

  projectArtifactDir(spec: Pick<ArtifactSpec, "kind"> & { id: string }): string {
    return join(this.projectDir, "analysis", sanitizeSegment(spec.kind), sanitizeSegment(spec.id));
  }

  private globalArtifactDir(kind: string, id: string): string | null {
    return this.globalDir ? join(this.globalDir, sanitizeSegment(kind), sanitizeSegment(id)) : null;
  }

  /**
   * The existing artifact for `spec`, project first then global, or null.
   * Corrupt entries (unreadable manifest, missing data file) are skipped,
   * never returned; failures recorded by `recordFailure` are skipped unless
   * `includeFailed` is set.
   */
  async lookup(spec: ArtifactSpec, options?: { includeFailed?: boolean }): Promise<AnalysisArtifact | null> {
    const id = ArtifactStore.keyFor(spec);
    const dirs = [this.projectArtifactDir({ kind: spec.kind, id })];
    const global = this.globalArtifactDir(spec.kind, id);
    if (global) dirs.push(global);
    for (const dir of dirs) {
      if (!options?.includeFailed && (await pathExists(join(dir, FAILURE_FILE)))) continue;
      const manifest = await readJsonFile<AnalysisArtifact>(join(dir, ARTIFACT_FILE));
      if (!manifest || manifest.id !== id) continue;
      if (await pathExists(join(dir, manifest.dataPath))) return { ...manifest, dataPath: join(dir, manifest.dataPath) };
    }
    return null;
  }

  /**
   * Creates the artifact for `spec`, running `write` inside a fresh temp
   * directory that is atomically renamed into place. `write` returns the
   * data file name (relative) plus any metadata to merge. Stale temp dirs
   * from crashed runs are removed first. Returns the stored artifact with
   * an absolute `dataPath`.
   */
  async create(
    spec: ArtifactSpec,
    write: (dir: string) => Promise<{ dataPath: string; metadata?: Record<string, unknown> }>,
  ): Promise<AnalysisArtifact> {
    const id = ArtifactStore.keyFor(spec);
    const dir = this.projectArtifactDir({ kind: spec.kind, id });
    const tmp = `${dir}${TMP_SUFFIX}-${process.pid}`;
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(tmp, { recursive: true });
    try {
      const { dataPath, metadata } = await write(tmp);
      if (!dataPath || dataPath.includes("..") || join(tmp, dataPath) !== join(tmp, sanitizeSegment(dataPath))) {
        // Allow subdirectories but never escape: resolve and verify containment.
        const resolved = join(tmp, dataPath);
        const prefix = `${tmp}${process.platform === "win32" ? "\\" : "/"}`;
        if (!resolved.startsWith(tmp) || resolved === tmp || !resolved.startsWith(prefix)) {
          throw new Error(`artifact: dataPath escapes its directory: ${JSON.stringify(dataPath)}`);
        }
      }
      if (!(await pathExists(join(tmp, dataPath)))) throw new Error(`artifact: data file missing: ${JSON.stringify(dataPath)}`);
      const artifact: AnalysisArtifact = {
        id,
        kind: spec.kind,
        sourceHash: spec.sourceHash,
        parametersHash: spec.parametersHash,
        engine: spec.engine,
        engineVersion: spec.engineVersion,
        createdAt: new Date().toISOString(),
        ...(spec.duration !== undefined ? { duration: spec.duration } : {}),
        ...(spec.fps !== undefined ? { fps: spec.fps } : {}),
        dataPath,
        metadata: { ...(spec.metadata ?? {}), ...(metadata ?? {}) },
      };
      await fs.writeFile(join(tmp, ARTIFACT_FILE), JSON.stringify(artifact, null, 2), "utf8");
      await fs.rm(join(tmp, FAILURE_FILE), { force: true });
      await fs.mkdir(join(this.projectDir, "analysis", sanitizeSegment(spec.kind)), { recursive: true });
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(tmp, dir);
      return { ...artifact, dataPath: join(dir, artifact.dataPath) };
    } catch (error) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  /** Records a failed run so repeat callers can see (and skip) it. */
  async recordFailure(spec: ArtifactSpec, error: unknown): Promise<void> {
    const id = ArtifactStore.keyFor(spec);
    const dir = this.projectArtifactDir({ kind: spec.kind, id });
    await fs.mkdir(dir, { recursive: true });
    const record: FailureRecord = {
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
      spec,
    };
    await fs.writeFile(join(dir, FAILURE_FILE), JSON.stringify(record, null, 2), "utf8");
  }

  /** The failure record for `spec`, if one was recorded. */
  async failure(spec: ArtifactSpec): Promise<FailureRecord | null> {
    return readJsonFile<FailureRecord>(join(this.projectArtifactDir({ kind: spec.kind, id: ArtifactStore.keyFor(spec) }), FAILURE_FILE));
  }

  /** Removes one artifact (or its failure record) from the project store. */
  async remove(spec: ArtifactSpec): Promise<boolean> {
    const dir = this.projectArtifactDir({ kind: spec.kind, id: ArtifactStore.keyFor(spec) });
    if (!(await pathExists(dir))) return false;
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  }

  /** Removes every artifact of `kind` (or everything) from the project store. */
  async invalidate(kind?: string): Promise<void> {
    const dir = kind ? join(this.projectDir, "analysis", sanitizeSegment(kind)) : join(this.projectDir, "analysis");
    await fs.rm(dir, { recursive: true, force: true });
  }

  /** Lists valid project artifacts, optionally filtered by kind. */
  async list(kind?: string): Promise<AnalysisArtifact[]> {
    const kinds = kind ? [sanitizeSegment(kind)] : await this.childDirs(join(this.projectDir, "analysis"));
    const out: AnalysisArtifact[] = [];
    for (const k of kinds) {
      for (const id of await this.childDirs(join(this.projectDir, "analysis", k))) {
        const dir = join(this.projectDir, "analysis", k, id);
        if (await pathExists(join(dir, FAILURE_FILE))) continue;
        const manifest = await readJsonFile<AnalysisArtifact>(join(dir, ARTIFACT_FILE));
        if (!manifest || manifest.id !== id) continue;
        if (await pathExists(join(dir, manifest.dataPath))) out.push({ ...manifest, dataPath: join(dir, manifest.dataPath) });
      }
    }
    return out;
  }

  private async childDirs(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
