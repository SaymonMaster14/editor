/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { AssetCandidate, AssetProvenance } from "../assets";

export const assetsImport = defineTool({
  name: "assets_import",
  title: "Import an internet asset",
  description:
    "Import one internet file into the open project's asset library: download it under guard (scheme/host allowlist, redirect budget, size and content-type enforcement), validate and probe it, hash it, store it as local project bytes, and record provenance (provider, query, URLs, author, license, SHA-256) on the asset. Pass exactly one of candidate (a hit from assets_search, verbatim — optionally with alternate set to an alternates[] label to import that rendition instead) or url (any direct file URL; provenance records provider 'url' and license 'unknown'). Needs an open project; the library path in the result is what compositions reference.",
  input: z
    .object({
      candidate: AssetCandidate.optional().describe("the assets_search hit to import, verbatim"),
      alternate: z.string().min(1).optional().describe("an alternates[] label from the candidate to import instead of its default download"),
      url: z.string().min(1).optional().describe("a direct file URL to import (exactly one of candidate/url)"),
      query: z.string().min(1).optional().describe("the search that surfaced a url import, recorded in provenance"),
      name: z.string().min(1).optional().describe("library file name (default: the remote file name)"),
      folder: z.string().optional().describe("library folder to place the asset in (default: root)"),
    })
    .superRefine((args, ctx) => {
      if ((args.candidate === undefined) === (args.url === undefined)) {
        ctx.addIssue({ code: "custom", message: "pass exactly one of candidate or url" });
      }
      if (args.url !== undefined && args.alternate !== undefined) {
        ctx.addIssue({ code: "custom", message: "alternate only applies to candidate imports" });
      }
    }),
  output: z.object({
    id: z.string().describe("asset id (content hash)"),
    path: z.string().describe("library path: what compositions reference as src"),
    name: z.string().describe("library file name"),
    type: z.string().describe("asset type: IMAGE, VIDEO, AUDIO, ..."),
    mimeType: z.string(),
    size: z.number().describe("stored bytes"),
    width: z.number().optional().describe("pixels, for visual assets"),
    height: z.number().optional().describe("pixels, for visual assets"),
    duration: z.number().optional().describe("seconds, for timed assets"),
    provenance: AssetProvenance,
  }),
  environment: "renderer",
});
