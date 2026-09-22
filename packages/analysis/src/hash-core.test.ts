/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cacheKeyAsync, hashBlobSampled, hashParamsAsync, sha256HexAsync, stableStringify } from "./hash-core";
import { cacheKey, hashFileSampled, hashParams, sha256Hex } from "./hash";

describe("sha256HexAsync", () => {
  it("matches the known SHA-256 of abc", async () => {
    await expect(sha256HexAsync("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("agrees with node:crypto on strings and bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await expect(sha256HexAsync("diffusion-studio")).resolves.toBe(sha256Hex("diffusion-studio"));
    await expect(sha256HexAsync(bytes)).resolves.toBe(sha256Hex(bytes));
  });
});

describe("stableStringify", () => {
  it("orders keys however the caller spelled the object", () => {
    expect(stableStringify({ b: 1, a: { d: [3, 2], c: null } })).toBe(stableStringify({ a: { c: null, d: [3, 2] }, b: 1 }));
  });

  it("drops undefined like JSON.stringify and rejects cycles", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(/circular/);
  });
});

describe("hashParamsAsync / cacheKeyAsync", () => {
  it("matches the node digests for the same input", async () => {
    const params = { threshold: 0.3, nested: { b: 1, a: 2 } };
    await expect(hashParamsAsync(params)).resolves.toBe(hashParams(params));
    const spec = { sourceHash: "aa", parametersHash: "bb", engine: "diffusion-scene", engineVersion: "1" };
    await expect(cacheKeyAsync(spec)).resolves.toBe(cacheKey(spec));
  });

  it("changes the key when any part changes", async () => {
    const base = { sourceHash: "aa", parametersHash: "bb", engine: "e", engineVersion: "1" };
    const keys = await Promise.all([
      cacheKeyAsync({ ...base, sourceHash: "zz" }),
      cacheKeyAsync({ ...base, parametersHash: "zz" }),
      cacheKeyAsync({ ...base, engine: "other" }),
      cacheKeyAsync({ ...base, engineVersion: "2" }),
    ]);
    const baseKey = await cacheKeyAsync(base);
    for (const key of keys) expect(key).not.toBe(baseKey);
    expect(new Set(keys).size).toBe(4);
  });
});

describe("hashBlobSampled", () => {
  it("is stable and distinguishes contents", async () => {
    const blob = new Blob(["frame-bytes-here"]);
    await expect(hashBlobSampled(blob)).resolves.toBe(await hashBlobSampled(new Blob(["frame-bytes-here"])));
    await expect(hashBlobSampled(blob)).resolves.not.toBe(await hashBlobSampled(new Blob(["other-bytes-here"])));
  });

  it("matches hashFileSampled on small and large files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "analysis-blob-"));
    try {
      const small = Buffer.from("tiny footage");
      const smallPath = join(dir, "small.bin");
      await writeFile(smallPath, small);
      await expect(hashBlobSampled(new Blob([small]))).resolves.toBe(await hashFileSampled(smallPath));

      // Past 3 MiB both sides hash head/middle/tail samples only.
      const large = Buffer.alloc(4 * 1024 * 1024);
      for (let i = 0; i < large.length; i++) large[i] = (i * 2654435761) % 251;
      const largePath = join(dir, "large.bin");
      await writeFile(largePath, large);
      await expect(hashBlobSampled(new Blob([large]))).resolves.toBe(await hashFileSampled(largePath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
