/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { toolByName } from "./catalog";

const candidate = {
  provider: "wikimedia",
  remoteId: "123",
  kind: "image",
  title: "Red Panda",
  license: { id: "cc-by-sa-4.0", name: "CC BY-SA 4.0" },
  thumbnail: { url: "https://upload.wikimedia.org/thumb.jpg", width: 320, height: 213 },
  download: { url: "https://upload.wikimedia.org/full.jpg", width: 3900, height: 2583, mimeType: "image/jpeg" },
  alternates: [{ label: "thumbnail", url: "https://upload.wikimedia.org/thumb.jpg" }],
  width: 3900,
  height: 2583,
};

describe("assets_import input", () => {
  const input = toolByName("assets_import").input;

  it("accepts a candidate import", () => {
    const parsed = input.safeParse({ candidate });
    expect(parsed.success).toBe(true);
  });

  it("accepts a candidate import with a known alternate", () => {
    const parsed = input.safeParse({ candidate, alternate: "thumbnail" });
    expect(parsed.success).toBe(true);
  });

  it("accepts a bare URL import", () => {
    const parsed = input.safeParse({ url: "https://example.com/clip.mp4", query: "ocean" });
    expect(parsed.success).toBe(true);
  });

  it("rejects candidate and url together, and neither", () => {
    expect(input.safeParse({ candidate, url: "https://example.com/x.png" }).success).toBe(false);
    expect(input.safeParse({}).success).toBe(false);
  });

  it("rejects alternate on a URL import", () => {
    expect(input.safeParse({ url: "https://example.com/x.png", alternate: "thumbnail" }).success).toBe(false);
  });
});

describe("assets wire schemas", () => {
  it("round-trips a search result through the search output", () => {
    const output = toolByName("assets_search").output;
    const parsed = output.safeParse({
      candidates: [candidate],
      outcomes: [
        { provider: "wikimedia", count: 1, error: null },
        { provider: "tenor", count: 0, error: 'Provider "tenor" needs a key (TENOR_API_KEY).' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips an import result through the import output", () => {
    const output = toolByName("assets_import").output;
    const parsed = output.safeParse({
      id: "abc123",
      path: "red-panda.jpg",
      name: "red-panda.jpg",
      type: "IMAGE",
      mimeType: "image/jpeg",
      size: 84545,
      width: 3900,
      height: 2583,
      provenance: {
        provider: "wikimedia",
        query: "red panda",
        sourceUrl: "https://upload.wikimedia.org/full.jpg",
        retrievedAt: new Date().toISOString(),
        sha256: "0".repeat(64),
        remoteId: "123",
      },
    });
    expect(parsed.success).toBe(true);
  });
});
