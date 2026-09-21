/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cacheKey, hashFileFull, hashFileSampled, hashParams, sha256Hex, stableStringify } from "./hash";

describe("sha256Hex", () => {
  it("hashes a known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("stableStringify", () => {
  it("orders keys deterministically", () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("treats key order as irrelevant", () => {
    expect(hashParams({ b: 1, a: 2 })).toBe(hashParams({ a: 2, b: 1 }));
  });

  it("distinguishes values", () => {
    expect(hashParams({ a: 1 })).not.toBe(hashParams({ a: 2 }));
  });

  it("rejects circular input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => stableStringify(circular)).toThrow(/circular/);
  });
});

describe("cacheKey", () => {
  const parts = { sourceHash: "s", parametersHash: "p", engine: "e", engineVersion: "1" };

  it("is stable", () => {
    expect(cacheKey(parts)).toBe(cacheKey({ ...parts }));
  });

  it("changes when any part changes", () => {
    const base = cacheKey(parts);
    expect(cacheKey({ ...parts, sourceHash: "s2" })).not.toBe(base);
    expect(cacheKey({ ...parts, parametersHash: "p2" })).not.toBe(base);
    expect(cacheKey({ ...parts, engine: "e2" })).not.toBe(base);
    expect(cacheKey({ ...parts, engineVersion: "2" })).not.toBe(base);
  });
});

describe("file hashing", () => {
  it("samples stably and matches full hash on small files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-hash-"));
    try {
      const path = join(dir, "small.bin");
      await writeFile(path, Buffer.from("hello diffusion"));
      expect(await hashFileSampled(path)).toBe(await hashFileSampled(path));
      expect(await hashFileFull(path)).toBe(sha256Hex(Buffer.from("hello diffusion")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes files that differ in head, middle or tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-hash-"));
    try {
      const size = 4 * 1024 * 1024;
      const base = Buffer.alloc(size, 0x41);
      const head = Buffer.from(base);
      head[0] = 0x42;
      const middle = Buffer.from(base);
      middle[Math.floor(size / 2)] = 0x42;
      const tail = Buffer.from(base);
      tail[size - 1] = 0x42;
      const paths = [join(dir, "base.bin"), join(dir, "head.bin"), join(dir, "middle.bin"), join(dir, "tail.bin")];
      await Promise.all([writeFile(paths[0]!, base), writeFile(paths[1]!, head), writeFile(paths[2]!, middle), writeFile(paths[3]!, tail)]);
      const hashes = await Promise.all(paths.map(hashFileSampled));
      expect(new Set(hashes).size).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
