/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { assetName, basename, provenanceForCandidate, provenanceForUrl } from "@diffusionstudio/assets";
import { DapiError } from "@diffusionstudio/dapi";
import { downloadViaMain } from "@/lib/assets-fetch";
import { mainBridge } from "@/lib/ipc";

import type {
  AssetCandidate,
  AssetKind,
  MultiSearchResult,
} from "@diffusionstudio/assets/internet";
import type { AssetLibrary } from "@diffusionstudio/assets";
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return hex(new Uint8Array(digest));
}

/** Search internet providers for importable media. Desktop only: the fan-out runs in main. */
export async function searchInternet(query: string, kinds?: AssetKind[]): Promise<MultiSearchResult> {
  return mainBridge.call(MAIN_CHANNELS.ASSETS_SEARCH, {
    query: { query, ...(kinds ? { kinds } : {}) },
  });
}

export type InternetImportInput = {
  candidate?: AssetCandidate;
  alternate?: string;
  url?: string;
  query?: string;
  name?: string;
  folder?: string;
};

/**
 * Imports one internet file into the library: resolves the guarded download
 * URL (a search candidate, one of its alternates, or a direct URL),
 * downloads it through main, and stores it with provenance. Returns the
 * stored asset.
 */
export async function importInternetAsset(library: AssetLibrary, input: InternetImportInput) {
  const { candidate, alternate, url, query, name, folder } = input;

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
    if (!url) throw new DapiError("invalid-input", "Import needs a search candidate or a direct file URL.");
    sourceUrl = url;
  }

  const { blob, finalUrl } = await downloadViaMain(sourceUrl);
  const sha256 = await sha256Hex(blob);
  const provenance = candidate
    ? provenanceForCandidate(candidate, { query, sourceUrl, finalUrl, rendition, sha256 })
    : provenanceForUrl({ sourceUrl, finalUrl, sha256 });

  const fileName = name ?? basename(sourceUrl.split(/[?#]/)[0]!) ?? "download";
  const asset = await library.store(blob, { name: fileName, folder, provenance });
  await library.flush();
  return { asset, name: assetName(asset), size: blob.size, provenance };
}
