/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * The wire shape of internet asset acquisition, shared by assets_search
 * (which returns candidates) and assets_import (which takes one back).
 * Mirrors the asset library's candidate and provenance types; the handlers
 * parse through these schemas, so drift fails loudly instead of silently.
 */

export const AssetKind = z.enum(["image", "video", "gif", "audio"]);

export const AssetOrientation = z.enum(["landscape", "portrait", "square"]);

export const AssetLicense = z.object({
  id: z.string().describe("license slug; 'unknown' when the provider said nothing usable, 'restricted' when the provider's own terms govern reuse"),
  name: z.string().describe("human license name"),
  url: z.string().optional().describe("license text URL, when known"),
});

export const AssetImageRef = z.object({
  url: z.string().describe("file URL"),
  width: z.number().int().positive().optional().describe("pixels"),
  height: z.number().int().positive().optional().describe("pixels"),
});

export const AssetDownload = z.object({
  url: z.string().describe("the file import fetches"),
  width: z.number().int().positive().optional().describe("pixels"),
  height: z.number().int().positive().optional().describe("pixels"),
  mimeType: z.string().optional().describe("provider-stated MIME type"),
  duration: z.number().optional().describe("seconds, for video/audio"),
  size: z.number().int().nonnegative().optional().describe("bytes, when the provider states it"),
});

export const AssetAlternate = z.object({
  label: z.string().describe("what this rendition is, e.g. 'original GIF'"),
  url: z.string().describe("file URL"),
  mimeType: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/** One normalized search hit: everything needed to choose, and to import. */
export const AssetCandidate = z.object({
  provider: z.string().describe("provider id: wikimedia, openverse, pexels, tenor"),
  remoteId: z.string().describe("provider-native id"),
  kind: AssetKind,
  title: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  authorUrl: z.string().optional(),
  license: AssetLicense,
  sourcePageUrl: z.string().optional().describe("provider landing page, for attribution and click-through"),
  thumbnail: AssetImageRef,
  download: AssetDownload.describe("the file import fetches; for GIFs the mp4 rendition when the provider offers one"),
  alternates: z.array(AssetAlternate).optional().describe("other renditions (original GIF, other sizes) the agent may prefer"),
  width: z.number().int().positive().optional().describe("pixels"),
  height: z.number().int().positive().optional().describe("pixels"),
  duration: z.number().optional().describe("seconds, for video/audio"),
});

/** What one provider contributed to a search: a count, or why it gave nothing. */
export const AssetProviderOutcome = z.object({
  provider: z.string(),
  count: z.number().int().nonnegative().describe("candidates this provider contributed"),
  error: z.string().nullable().describe("why this provider contributed nothing: missing key, rate limit, outage, or no support for the query"),
});

/** Provenance as stored on an imported asset. */
export const AssetProvenance = z.object({
  provider: z.string().describe("provider id, or 'url' for a direct URL import"),
  query: z.string().optional().describe("the search query that surfaced the asset, when there was one"),
  sourceUrl: z.string().describe("the exact file URL that was fetched"),
  finalUrl: z.string().optional().describe("where the bytes came from after redirects, when different"),
  assetPageUrl: z.string().optional().describe("provider landing page, for attribution"),
  author: z.string().optional(),
  authorUrl: z.string().optional(),
  license: z.string().optional().describe("license name, or 'unknown' when the provider said nothing usable"),
  licenseUrl: z.string().optional(),
  retrievedAt: z.string().describe("ISO timestamp of the import"),
  sha256: z.string().describe("SHA-256 of the stored bytes, hex"),
  remoteId: z.string().optional().describe("provider-native id, for re-resolution and debugging"),
  rendition: z.string().optional().describe("rendition note, e.g. which alternate of a GIF was imported"),
});
