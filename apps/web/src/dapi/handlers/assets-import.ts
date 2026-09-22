/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLibrary } from "@diffusionstudio/runtime";
import { assetName, basename, provenanceForCandidate, provenanceForUrl } from "@diffusionstudio/assets";
import { DapiError } from "@diffusionstudio/dapi";
import { downloadViaMain } from "@/lib/assets-fetch";

import type { AssetProvenance as LibraryProvenance } from "@diffusionstudio/assets";
import type { ToolHandler } from "../handler";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return hex(new Uint8Array(digest));
}

export const assetsImport: ToolHandler<"assets_import"> = async (
  { candidate, alternate, url, query, name, folder },
  ctx,
) => {
  const { world } = ctx.requireSession();
  const library = getLibrary(world);

  let sourceUrl: string;
  let rendition: string | undefined;
  if (candidate) {
    const chosen = alternate
      ? candidate.alternates?.find((entry) => entry.label === alternate)
      : undefined;
    if (alternate && !chosen) {
      const known = candidate.alternates?.map((entry) => entry.label).join(", ") || "none";
      throw new DapiError("invalid-input", `Unknown alternate "${alternate}" for this candidate (has: ${known}).`);
    }
    sourceUrl = chosen?.url ?? candidate.download.url;
    rendition = chosen ? `alternate: ${chosen.label}` : undefined;
  } else {
    sourceUrl = url!;
  }

  const { blob, finalUrl } = await downloadViaMain(sourceUrl);
  const sha256 = await sha256Hex(blob);
  const provenance: LibraryProvenance = candidate
    ? provenanceForCandidate(candidate, { query, sourceUrl, finalUrl, rendition, sha256 })
    : provenanceForUrl({ sourceUrl, finalUrl, sha256 });

  const fileName = name ?? basename(sourceUrl.split(/[?#]/)[0]!) ?? "download";
  const asset = await library.store(blob, { name: fileName, folder, provenance });
  await library.flush();

  return {
    id: asset.id,
    path: asset.path,
    name: assetName(asset),
    type: asset.type,
    mimeType: asset.mimeType,
    size: blob.size,
    ...("width" in asset && { width: asset.width, height: asset.height }),
    ...("duration" in asset && { duration: asset.duration }),
    provenance,
  };
};
