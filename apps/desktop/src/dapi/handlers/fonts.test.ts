/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { filterFamilies, fonts } from "./fonts";

import type { FontFamily } from "@diffusionstudio/dapi";
import type { MainContext } from "../handler";

const win32 = platform() === "win32";
const ctx = (): MainContext => ({ signal: new AbortController().signal, logs: () => [], version: "0" });

const sample: FontFamily[] = [
  {
    family: "Arial",
    variants: [
      { weight: "400", style: "normal", source: "local('Arial')" },
      { weight: "700", style: "normal", source: "local('Arial Bold')" },
      { weight: "400", style: "italic", source: "local('Arial Italic')" },
    ],
  },
  {
    family: "Times New Roman",
    variants: [{ weight: "400", style: "normal", source: "local('Times New Roman')" }],
  },
  {
    family: "Courier New",
    variants: [{ weight: "700", style: "italic", source: "local('Courier New Bold Italic')" }],
  },
];

describe("filterFamilies", () => {
  it("matches family names case-insensitively", () => {
    const { families, total } = filterFamilies(sample, { family: "aRiAl" });
    expect(total).toBe(1);
    expect(families.map((f) => f.family)).toEqual(["Arial"]);
  });

  it("keeps only the wanted weights and styles, dropping emptied families", () => {
    const { families, total } = filterFamilies(sample, { weights: ["700"], style: "italic" });
    expect(total).toBe(1);
    expect(families).toEqual([
      {
        family: "Courier New",
        variants: [{ weight: "700", style: "italic", source: "local('Courier New Bold Italic')" }],
      },
    ]);
  });

  it("cuts the list at the limit but counts every match", () => {
    const { families, total } = filterFamilies(sample, { limit: 2 });
    expect(families).toHaveLength(2);
    expect(total).toBe(3);
  });

  it("returns everything unfiltered", () => {
    const { families, total } = filterFamilies(sample, {});
    expect(total).toBe(3);
    expect(families).toEqual(sample);
  });
});

describe.runIf(win32)("fonts handler on Windows", () => {
  it("lists real families through the handler", async () => {
    const { families, total } = await fonts({ family: "arial" }, ctx());
    expect(total).toBeGreaterThanOrEqual(1);
    expect(families.map((f) => f.family)).toContain("Arial");
  });

  it("honors weights, style and limit on real data", async () => {
    const { families, total } = await fonts({ family: "arial", weights: ["700"], limit: 1 }, ctx());
    expect(total).toBeGreaterThanOrEqual(1);
    expect(families).toHaveLength(1);
    for (const variant of families[0]?.variants ?? []) expect(variant.weight).toBe("700");
    const italic = await fonts({ family: "arial", style: "italic" }, ctx());
    expect(italic.total).toBeGreaterThanOrEqual(1);
  });
});
