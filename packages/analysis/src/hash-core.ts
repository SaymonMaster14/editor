/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Portable hashing core: no node imports, so browser/renderer contexts
// (the DAPI handlers) can hash content and parameters exactly like the
// node side. SHA-256 goes through WebCrypto, which exists in browsers,
// Electron renderers, and modern node. The digests are plain SHA-256,
// so `cacheKeyAsync` returns byte-identical ids to node's `cacheKey`
// for the same spec, and `hashBlobSampled` matches `hashFileSampled`
// for the same bytes: either backend can read the other's keys.

/** Bytes hashed from each of the head, middle and tail of large content. */
export const SAMPLE_BYTES = 1024 * 1024;

// Structural WebCrypto view: this package typechecks without DOM lib, so
// the platform Crypto/SubtleCrypto types are named structurally instead.
type WebDigest = {
  digest: (algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
};

function subtle(): WebDigest {
  const crypto = (globalThis as { crypto?: { subtle?: WebDigest } }).crypto;
  if (!crypto?.subtle) {
    throw new Error("analysis: WebCrypto (globalThis.crypto.subtle) is unavailable in this context");
  }
  return crypto.subtle;
}

function toBytes(data: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  // Copy so the digest input is a plain ArrayBuffer view.
  return new Uint8Array(data);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex of the SHA-256 of `data`. */
export async function sha256HexAsync(data: string | Uint8Array): Promise<string> {
  return hex(await subtle().digest("SHA-256", toBytes(data) as Uint8Array<ArrayBuffer>));
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
export async function hashParamsAsync(params: unknown): Promise<string> {
  return sha256HexAsync(`params\n${stableStringify(params)}`);
}

/**
 * The cache key for one analysis run:
 * source hash + parameter hash + engine id/version, hashed together.
 * The preimage matches node's `cacheKey`, so both backends agree.
 */
export async function cacheKeyAsync(parts: {
  sourceHash: string;
  parametersHash: string;
  engine: string;
  engineVersion: string;
}): Promise<string> {
  return sha256HexAsync(["v1", parts.sourceHash, parts.parametersHash, parts.engine, parts.engineVersion].join("\0"));
}

/**
 * The content id of a Blob: `size` plus, for small blobs, every byte,
 * else the head, middle and tail samples — the same scheme as node's
 * `hashFileSampled`, so both produce the same digest for the same bytes.
 * Reads at most 3 MiB regardless of blob size; decode-free.
 */
export async function hashBlobSampled(blob: Blob): Promise<string> {
  const size = blob.size;
  const head = [`size:${size}\n`];
  const parts: Blob[] = [];
  if (size <= SAMPLE_BYTES * 3) {
    parts.push(blob);
  } else {
    const middle = Math.floor(size / 2 - SAMPLE_BYTES / 2);
    for (const offset of [0, middle, size - SAMPLE_BYTES]) {
      parts.push(blob.slice(offset, offset + SAMPLE_BYTES));
    }
  }
  const prefix = new TextEncoder().encode(head[0]!);
  const chunks = [prefix];
  for (const part of parts) chunks.push(new Uint8Array(await part.arrayBuffer()));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return sha256HexAsync(bytes);
}
