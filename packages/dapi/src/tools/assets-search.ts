/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetCandidate, AssetKind, AssetOrientation, AssetProviderOutcome } from "../assets";

export const assetsSearch = defineTool({
  name: "assets_search",
  title: "Search internet assets",
  description:
    "Search the internet for importable media — images, GIFs, stock video — across the registered providers (Wikimedia Commons and Openverse need no key; Pexels and Tenor need user-supplied API keys from PEXELS_API_KEY/TENOR_API_KEY or the keys argument). Returns candidates the agent compares before importing: thumbnail, dimensions, duration, author, and the provider-stated license — 'unknown' means unstated, 'restricted' (Tenor) means reuse is limited and the user must be told. One provider failing (rate limit, outage, missing key) never fails the search: its outcome says why. Import the chosen candidate with assets_import; the project keeps a local copy plus provenance, so it never depends on the remote URL surviving. Needs no open project.",
  input: z.object({
    query: z.string().min(1).describe("what to look for"),
    providers: z
      .array(z.string().min(1))
      .optional()
      .describe("provider ids to search (default: all registered); unknown ids come back as error outcomes"),
    kinds: z.array(AssetKind).optional().describe("media kinds to accept (default: whatever the providers return)"),
    orientation: AssetOrientation.optional().describe("image orientation filter, where the provider supports it"),
    license: z
      .string()
      .min(1)
      .optional()
      .describe("'reusable' (default): commercially usable, modifiable works where the provider can express that; 'any': whatever matches; anything else passes through as a raw license slug"),
    safe: z.boolean().optional().describe("prefer safe-search filtering where the provider offers it (default: true)"),
    page: z.int().min(1).optional().describe("page of results (default: 1)"),
    perPage: z.int().min(1).max(50).optional().describe("hits per provider (default: 10)"),
    keys: z
      .record(z.string(), z.string().min(1))
      .optional()
      .describe("API keys by provider id (pexels, tenor); unset keys fall back to PEXELS_API_KEY/TENOR_API_KEY in the environment"),
  }),
  output: z.object({
    candidates: z.array(AssetCandidate).describe("every provider's hits, most permissive license first"),
    outcomes: z.array(AssetProviderOutcome).describe("per provider: how many hits, or why none"),
  }),
  environment: "main",
});
