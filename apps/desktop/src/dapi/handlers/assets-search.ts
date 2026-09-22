/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toolByName } from "@diffusionstudio/dapi";
import { searchInternetAssets } from "../../assets-fetch";

import type { MultiSearchResult } from "@diffusionstudio/assets/internet";
import type { AssetsSearchResult } from "@diffusionstudio/dapi";
import type { MainHandler } from "../handler";

/**
 * Shapes a multi-provider search for the wire: every provider's hits in
 * one candidate list, plus a slim per-provider outcome (count, or why it
 * gave nothing). Parsed through the tool's output schema, so a provider
 * returning something the catalog cannot describe fails here, loudly.
 */
export function toSearchOutput(multi: MultiSearchResult): AssetsSearchResult {
  return toolByName("assets_search").output.parse({
    candidates: multi.candidates,
    outcomes: multi.outcomes.map((outcome) => ({
      provider: outcome.provider,
      count: outcome.result?.candidates.length ?? 0,
      error: outcome.error,
    })),
  });
}

export const assetsSearch: MainHandler<"assets_search"> = async (
  { query, providers, kinds, orientation, license, safe, page, perPage, keys },
  ctx,
) => {
  const multi = await searchInternetAssets(
    {
      providers,
      query: { query, kinds, orientation, license, safe, page, perPage },
      keys,
    },
    { signal: ctx.signal },
  );
  return toSearchOutput(multi);
};
