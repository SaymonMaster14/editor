/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Content and parameter identity for cached media analysis. Footage runs to
// gigabytes, so file identity is sampled (size + head/middle/tail) by
// default and full only when asked; parameter identity is a SHA-256 over a
// deterministic serialization, so the same logical options hash the same
// however the caller spelled the object.

import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";

/** Bytes hashed from each of the head, middle and tail of a large file. */
export const SAMPLE_BYTES = 1024 * 1024;

/** Hex of the SHA-256 of `data`. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The content id of a file: `size` plus, for small files, every byte, else
 * the head, middle and tail samples. Stable for the same file, millisecond
 * cheap on multi-gigabyte footage.
 */
export async function hashFileSampled(path: string): Promise<string> {
  const stat = await fs.stat(path);
  const size = stat.size;
  const hash = createHash("sha256");
  hash.update(`size:${size}\n`);
  const handle = await fs.open(path, "r");
  try {
    if (size <= SAMPLE_BYTES * 3) {
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, 0);
      hash.update(buf);
    } else {
      for (const offset of [0, Math.floor(size / 2 - SAMPLE_BYTES / 2), size - SAMPLE_BYTES]) {
        const buf = Buffer.alloc(SAMPLE_BYTES);
        await handle.read(buf, 0, SAMPLE_BYTES, offset);
        hash.update(buf);
      }
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** The SHA-256 of every byte of a file, streamed. */
export function hashFileFull(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` dropped
 * like JSON.stringify, no whitespace. Throws on circular input.
 */
export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const encode = (node: unknown): string => {
    if (node === null) return "null";
    switch (typeof node) {
      case "string":
        return JSON.stringify(node);
      case "number":
        return Number.isFinite(node) ? String(node) : "null";
      case "boolean":
        return node ? "true" : "false";
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        return "null";
      case "object": {
        if (seen.has(node)) throw new Error("stableStringify: circular value");
        seen.add(node);
        try {
          if (Array.isArray(node)) return `[${node.map(encode).join(",")}]`;
          const entries = Object.entries(node as Record<string, unknown>)
            .filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol")
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
          return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v)}`).join(",")}}`;
        } finally {
          seen.delete(node);
        }
      }
      default:
        return "null";
    }
  };
  return encode(value);
}

/** The identity of an analysis parameter set. */
export function hashParams(params: unknown): string {
  return sha256Hex(`params\n${stableStringify(params)}`);
}

/**
 * The cache key for one analysis run:
 * source hash + parameter hash + engine id/version, hashed together.
 */
export function cacheKey(parts: { sourceHash: string; parametersHash: string; engine: string; engineVersion: string }): string {
  return sha256Hex(["v1", parts.sourceHash, parts.parametersHash, parts.engine, parts.engineVersion].join("\0"));
}
