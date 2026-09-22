/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Internet asset acquisition in the main process. Provider search and file
// downloads run here rather than in the renderer, where CORS would block
// provider APIs and fetch cannot resolve DNS for the SSRF guard. Both go
// through the shared guard core in @diffusionstudio/assets; main only adds
// the Node pieces (DNS resolution, a User-Agent, API keys from the
// environment) and shapes the results for IPC.

import { lookup } from "node:dns/promises";

import {
  downloadUrl,
  fetchJsonGuarded,
  nodeDownloadFetch,
  searchProviders,
} from "@diffusionstudio/assets/internet";

import type {
  AssetSearchQuery,
  MultiSearchResult,
  ProviderContext,
} from "@diffusionstudio/assets/internet";

/** Resolves a hostname to literal IP addresses for the SSRF guard. */
export async function nodeResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((record) => record.address);
}

export interface InternetSearchRequest {
  /** Provider ids to fan out to; all registered providers when unset. */
  providers?: string[];
  query: AssetSearchQuery;
  /** API keys by provider id; missing keys fall back to the environment. */
  keys?: Record<string, string | undefined>;
  userAgent?: string;
}

/**
 * Searches internet providers for import candidates. Keys the caller did
 * not pass are read from the environment (`PEXELS_API_KEY`,
 * `TENOR_API_KEY`); providers without a key they need report an outcome
 * saying so instead of failing the search.
 */
export async function searchInternetAssets(
  request: InternetSearchRequest,
  options: { signal?: AbortSignal } = {},
): Promise<MultiSearchResult> {
  const userAgent = request.userAgent ?? "DiffusionStudio";
  const keys: Record<string, string | undefined> = { ...request.keys };
  keys.pexels ??= process.env.PEXELS_API_KEY;
  keys.tenor ??= process.env.TENOR_API_KEY;
  const ctx: ProviderContext = {
    fetchJson: async (url, init) => {
      const { status, body, retryAfter } = await fetchJsonGuarded(url, {
        signal: options.signal,
        fetchImpl: nodeDownloadFetch,
        resolveHost: nodeResolveHost,
        headers: { "user-agent": userAgent, ...init?.headers },
      });
      return { status, body, retryAfter };
    },
    userAgent,
    keys,
  };
  return searchProviders(request.providers, request.query, ctx);
}

export interface InternetDownloadRequest {
  url: string;
  /** Byte ceiling; the shared default (250 MiB) when unset. */
  maxBytes?: number;
  /** Wall clock in ms; the shared default (60 s) when unset. */
  timeoutMs?: number;
}

export interface InternetDownloadResult {
  /** The downloaded bytes. */
  data: Uint8Array;
  /** Where the bytes came from, after redirects. */
  finalUrl: string;
  /** The validated content type, without parameters. */
  contentType: string;
}

/**
 * Downloads one file under guard: validated hops, resolved DNS, redirect
 * budget, content-type and size enforcement. Used for provider files and
 * bare URL imports alike.
 */
export async function downloadInternetAsset(
  request: InternetDownloadRequest,
): Promise<InternetDownloadResult> {
  const { bytes, finalUrl, contentType } = await downloadUrl(request.url, {
    fetchImpl: nodeDownloadFetch,
    resolveHost: nodeResolveHost,
    maxBytes: request.maxBytes,
    timeoutMs: request.timeoutMs,
  });
  return { data: bytes, finalUrl, contentType };
}
