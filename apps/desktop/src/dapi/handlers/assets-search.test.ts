/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { toSearchOutput } from "./assets-search";

import type { AssetCandidate, MultiSearchResult } from "@diffusionstudio/assets/internet";

function candidate(overrides: Partial<AssetCandidate> = {}): AssetCandidate {
  return {
    provider: "wikimedia",
    remoteId: "123",
    kind: "image",
    title: "Red Panda",
    license: { id: "cc-by-sa-4.0", name: "CC BY-SA 4.0" },
    thumbnail: { url: "https://upload.wikimedia.org/thumb.jpg" },
    download: { url: "https://upload.wikimedia.org/full.jpg" },
    ...overrides,
  };
}

describe("toSearchOutput", () => {
  it("merges hits and slims per-provider outcomes", () => {
    const multi: MultiSearchResult = {
      candidates: [candidate(), candidate({ provider: "openverse", remoteId: "456", title: "Panda" })],
      outcomes: [
        { provider: "wikimedia", result: { candidates: [candidate()], page: 1, perPage: 10, total: 42 }, error: null },
        { provider: "tenor", result: null, error: 'Provider "tenor" needs a key (TENOR_API_KEY).' },
      ],
    };
    expect(toSearchOutput(multi)).toEqual({
      candidates: multi.candidates,
      outcomes: [
        { provider: "wikimedia", count: 1, error: null },
        { provider: "tenor", count: 0, error: 'Provider "tenor" needs a key (TENOR_API_KEY).' },
      ],
    });
  });

  it("rejects a provider hit the catalog cannot describe", () => {
    const multi = {
      candidates: [{ provider: "rogue", kind: "smell" }],
      outcomes: [{ provider: "rogue", result: null, error: null }],
    } as unknown as MultiSearchResult;
    expect(() => toSearchOutput(multi)).toThrow();
  });
});
