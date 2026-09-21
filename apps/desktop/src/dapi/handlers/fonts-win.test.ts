/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bufferReader,
  cssWeight,
  groupFamilies,
  listWindowsFonts,
  listWindowsFontsFromEntries,
  parseReader,
  parseRegistryJson,
  stripFontKind,
  variantFromDisplayName,
} from "./fonts-win";

const win32 = platform() === "win32";

// --- synthetic sfnt builder ---------------------------------------------------

type NameEntry = { id: number; text: string; platform?: number; encoding?: number; language?: number };

function encodeUtf16be(text: string): Buffer {
  const buf = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) buf.writeUInt16BE(text.charCodeAt(i), i * 2);
  return buf;
}

function nameTable(entries: NameEntry[]): Buffer {
  const records: Buffer[] = [];
  const strings: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const plat = e.platform ?? 3;
    const str = plat === 1 ? Buffer.from(e.text, "latin1") : encodeUtf16be(e.text);
    const rec = Buffer.alloc(12);
    rec.writeUInt16BE(plat, 0);
    rec.writeUInt16BE(e.encoding ?? (plat === 1 ? 0 : 1), 2);
    rec.writeUInt16BE(e.language ?? 0x409, 4);
    rec.writeUInt16BE(e.id, 6);
    rec.writeUInt16BE(str.length, 8);
    rec.writeUInt16BE(offset, 10);
    records.push(rec);
    strings.push(str);
    offset += str.length;
  }
  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(entries.length, 2);
  header.writeUInt16BE(6 + entries.length * 12, 4);
  return Buffer.concat([header, ...records, ...strings]);
}

function os2Table(weightClass: number): Buffer {
  const buf = Buffer.alloc(78);
  buf.writeUInt16BE(4, 0);
  buf.writeUInt16BE(weightClass, 4);
  return buf;
}

function headTable(italic: boolean): Buffer {
  const buf = Buffer.alloc(54);
  buf.writeUInt32BE(0x00010000, 0);
  buf.writeUInt16BE(0x0003, 16); // flags, whose low bits must NOT read as italic
  buf.writeUInt16BE(italic ? 0x02 : 0x00, 44); // macStyle
  return buf;
}

function sfnt(tables: Array<{ tag: string; data: Buffer }>): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(tables.length, 4);
  let offset = 12 + tables.length * 16;
  const dir: Buffer[] = [];
  const bodies: Buffer[] = [];
  for (const t of tables) {
    const entry = Buffer.alloc(16);
    entry.write(t.tag, 0, 4, "ascii");
    entry.writeUInt32BE(0, 4);
    entry.writeUInt32BE(offset, 8);
    entry.writeUInt32BE(t.data.length, 12);
    dir.push(entry);
    bodies.push(t.data);
    offset += t.data.length;
  }
  return Buffer.concat([header, ...dir, ...bodies]);
}

function testFont(opts: { family?: string; subfamily?: string; weight?: number; italic?: boolean; typoFamily?: string } = {}): Buffer {
  const family = opts.family ?? "Test Family";
  const subfamily = opts.subfamily ?? "Bold Italic";
  const names: NameEntry[] = [
    { id: 1, text: family },
    { id: 2, text: subfamily },
    { id: 4, text: `${family} ${subfamily}` },
    { id: 6, text: `${family.replace(/ /g, "")}-${subfamily.replace(/ /g, "")}` },
  ];
  if (opts.typoFamily) {
    names.push({ id: 16, text: opts.typoFamily });
    names.push({ id: 17, text: "W800 It" });
  }
  return sfnt([
    { tag: "name", data: nameTable(names) },
    { tag: "OS/2", data: os2Table(opts.weight ?? 700) },
    { tag: "head", data: headTable(opts.italic ?? true) },
  ]);
}

/** A member with its table offsets rebased to file-absolute, as real collections store them. */
function shiftOffsets(font: Buffer, base: number): Buffer {
  const copy = Buffer.from(font);
  const numTables = copy.readUInt16BE(4);
  for (let k = 0; k < numTables; k++) {
    const at = 12 + k * 16 + 8;
    copy.writeUInt32BE(base + copy.readUInt32BE(at), at);
  }
  return copy;
}

function ttc(fonts: Buffer[]): Buffer {
  const header = Buffer.alloc(12 + fonts.length * 4);
  header.write("ttcf", 0, 4, "ascii");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(fonts.length, 8);
  let base = header.length;
  const patched: Buffer[] = [];
  fonts.forEach((f, i) => {
    header.writeUInt32BE(base, 12 + i * 4);
    patched.push(shiftOffsets(f, base));
    base += f.length;
  });
  return Buffer.concat([header, ...patched]);
}

// --- parser -------------------------------------------------------------------

describe("parseReader", () => {
  it("reads family, weight and italic from a synthetic TTF", () => {
    const faces = parseReader(bufferReader(testFont()));
    expect(faces).toEqual([
      {
        family: "Test Family",
        fullName: "Test Family Bold Italic",
        postscript: "TestFamily-BoldItalic",
        weightClass: 700,
        italic: true,
      },
    ]);
  });

  it("prefers the typographic family over the legacy one", () => {
    const faces = parseReader(bufferReader(testFont({ typoFamily: "Test Typo" })));
    expect(faces[0]?.family).toBe("Test Typo");
  });

  it("prefers US-English Windows Unicode names whatever order they come in", () => {
    const names = nameTable([
      { id: 1, text: "Mac", platform: 1, encoding: 0 },
      { id: 1, text: "Deutsch", language: 0x407 },
      { id: 1, text: "English" },
      { id: 2, text: "Regular" },
    ]);
    const faces = parseReader(bufferReader(sfnt([{ tag: "name", data: names }])));
    expect(faces[0]?.family).toBe("English");
  });

  it("takes italic from the subfamily word when the head bit is clear, and only then", () => {
    const oblique = parseReader(bufferReader(testFont({ subfamily: "Oblique", italic: false })));
    expect(oblique[0]?.italic).toBe(true);
    const regular = parseReader(bufferReader(testFont({ subfamily: "Regular", italic: false, weight: 400 })));
    expect(regular[0]?.italic).toBe(false);
  });

  it("defaults the weight to 400 without an OS/2 table", () => {
    const buf = sfnt([{ tag: "name", data: nameTable([{ id: 1, text: "F" }]) }]);
    expect(parseReader(bufferReader(buf))[0]?.weightClass).toBe(400);
  });

  it("accepts the CFF flavor", () => {
    const buf = testFont();
    buf.write("OTTO", 0, 4, "ascii");
    expect(parseReader(bufferReader(buf))).toHaveLength(1);
  });

  it("parses every member of a collection and skips corrupt ones", () => {
    const good = ttc([testFont({ family: "One" }), testFont({ family: "Two", subfamily: "Regular", weight: 400, italic: false })]);
    expect(parseReader(bufferReader(good)).map((f) => f.family)).toEqual(["One", "Two"]);

    const header = Buffer.alloc(20);
    header.write("ttcf", 0, 4, "ascii");
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt32BE(2, 8);
    header.writeUInt32BE(20, 12);
    header.writeUInt32BE(0xffffff, 16);
    const partial = parseReader(bufferReader(Buffer.concat([header, shiftOffsets(testFont({ family: "Solo" }), 20)])));
    expect(partial.map((f) => f.family)).toEqual(["Solo"]);
  });

  it("returns nothing for garbage, truncation, or missing tables", () => {
    expect(parseReader(bufferReader(Buffer.alloc(0)))).toEqual([]);
    expect(parseReader(bufferReader(Buffer.from("not a font at all, just text")))).toEqual([]);
    expect(parseReader(bufferReader(testFont().subarray(0, 40)))).toEqual([]);
    expect(parseReader(bufferReader(sfnt([{ tag: "head", data: headTable(false) }])))).toEqual([]);
    // A name table pointing outside the file is not a font either.
    const names = nameTable([{ id: 1, text: "F" }]);
    names.writeUInt16BE(0xffff, 6 + 10);
    expect(parseReader(bufferReader(sfnt([{ tag: "name", data: names }])))).toEqual([]);
  });
});

describe("cssWeight", () => {
  it("rounds the OS/2 class to CSS hundreds and clamps", () => {
    expect([100, 250, 350, 400, 700, 1000, 0, Number.NaN].map(cssWeight)).toEqual([
      "100",
      "300",
      "400",
      "400",
      "700",
      "900",
      "100",
      "400",
    ]);
  });
});

// --- display-name fallback ------------------------------------------------------

describe("variantFromDisplayName", () => {
  it("splits trailing style words off the family", () => {
    expect(variantFromDisplayName("Arial Bold Italic (TrueType)")).toEqual({ family: "Arial", weight: "700", style: "italic" });
    expect(variantFromDisplayName("Segoe UI Semibold")).toEqual({ family: "Segoe UI", weight: "600", style: "normal" });
    expect(variantFromDisplayName("Bahnschrift Light")).toEqual({ family: "Bahnschrift", weight: "300", style: "normal" });
  });

  it("keeps ordinary words in the family", () => {
    expect(variantFromDisplayName("Times New Roman (TrueType)")).toEqual({
      family: "Times New Roman",
      weight: "400",
      style: "normal",
    });
    expect(variantFromDisplayName("Segoe UI Variable")).toEqual({ family: "Segoe UI Variable", weight: "400", style: "normal" });
    expect(variantFromDisplayName("MS Sans Serif 8,10,12,14,18,24 (VGA res)")).toEqual({
      family: "MS Sans Serif 8,10,12,14,18,24",
      weight: "400",
      style: "normal",
    });
  });

  it("refuses empty names", () => {
    expect(variantFromDisplayName("")).toBeNull();
    expect(variantFromDisplayName("(TrueType)")).toBeNull();
  });

  it("strips the font-kind suffix", () => {
    expect(stripFontKind("Arial (TrueType)")).toBe("Arial");
    expect(stripFontKind("No Suffix")).toBe("No Suffix");
  });
});

// --- registry -------------------------------------------------------------------

describe("parseRegistryJson", () => {
  it("reads an array, a single object, or nothing", () => {
    expect(parseRegistryJson('[{"name":"A (TrueType)","file":"a.ttf"}]')).toEqual([{ name: "A (TrueType)", file: "a.ttf" }]);
    expect(parseRegistryJson('{"name":"A","file":"a.ttf"}')).toEqual([{ name: "A", file: "a.ttf" }]);
    expect(parseRegistryJson("")).toEqual([]);
    expect(parseRegistryJson("  \n ")).toEqual([]);
  });

  it("skips malformed entries and refuses malformed output", () => {
    expect(parseRegistryJson('[{"name":"A"},{"file":"b.ttf"},{"name":"","file":""},{"name":"C","file":"c.ttf"},null,7]')).toEqual([
      { name: "C", file: "c.ttf" },
    ]);
    expect(() => parseRegistryJson("{oops")).toThrow();
  });
});

describe("listWindowsFonts", () => {
  it("asks PowerShell for both hives as UTF-8 JSON", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const families = listWindowsFonts({
      spawn: ((command: string, args: string[]) => {
        calls.push({ command, args });
        return { status: 0, stdout: '[{"name":"A (TrueType)","file":"C:\\\\x\\\\a.ttf"}]', stderr: "" };
      }) as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args).toContain("-NoProfile");
    const script = calls[0]?.args[calls[0].args.indexOf("-Command") + 1] ?? "";
    expect(script).toContain("HKLM:");
    expect(script).toContain("HKCU:");
    expect(script).toContain("CurrentVersion\\Fonts");
    expect(script).toContain("UTF8");
    expect(script).toContain("ConvertTo-Json");
    // The file does not exist, so the family comes from the display-name fallback.
    expect(families).toEqual([{ family: "A", variants: [{ weight: "400", style: "normal", source: "local('A')" }] }]);
  });

  it("fails loudly when PowerShell does", () => {
    expect(() =>
      listWindowsFonts({ spawn: (() => ({ status: 1, stdout: "", stderr: "boom" })) as never }),
    ).toThrow("boom");
    expect(() =>
      listWindowsFonts({ spawn: (() => ({ status: null, stdout: "", stderr: "", error: new Error("no shell") })) as never }),
    ).toThrow("no shell");
  });
});

// --- assembly ---------------------------------------------------------------------

describe("listWindowsFontsFromEntries", () => {
  const face = (family: string, weightClass = 400, italic = false) => ({
    family,
    fullName: family,
    postscript: family.replace(/ /g, ""),
    weightClass,
    italic,
  });

  it("parses each file once, skips vertical aliases, and falls back for the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "fonts-win-"));
    writeFileSync(join(dir, "a.ttf"), "");
    const seen: string[] = [];
    const families = listWindowsFontsFromEntries(
      [
        { name: "A (TrueType)", file: "a.ttf" },
        { name: "A Duplicate (TrueType)", file: "a.ttf" },
        { name: "@A Vertical (TrueType)", file: "a.ttf" },
        { name: "B Bold (TrueType)", file: "missing.ttf" },
      ],
      {
        fontDirs: [dir],
        readFaces: (path) => {
          seen.push(path);
          return path.endsWith("a.ttf") ? [face("A")] : [];
        },
      },
    );
    expect(seen).toEqual([join(dir, "a.ttf")]);
    expect(families).toEqual([
      { family: "A", variants: [{ weight: "400", style: "normal", source: "local('A'), local('A')" }] },
      { family: "B", variants: [{ weight: "700", style: "normal", source: "local('B Bold')" }] },
    ]);
  });

  it("takes absolute file values as-is", () => {
    const families = listWindowsFontsFromEntries([{ name: "U (TrueType)", file: "C:\\Users\\u\\x.ttf" }], {
      fontDirs: [],
      readFaces: (path) => (path === "C:\\Users\\u\\x.ttf" ? [face("U")] : []),
    });
    expect(families.map((f) => f.family)).toEqual(["U"]);
  });
});

describe("groupFamilies", () => {
  it("dedupes variants and sorts families and variants", () => {
    const families = groupFamilies(
      [
        { family: "B", fullName: "B", postscript: "B", weightClass: 700, italic: false },
        { family: "A", fullName: "A", postscript: "A", weightClass: 400, italic: true },
        { family: "B", fullName: "B", postscript: "B", weightClass: 700, italic: false },
        { family: "A", fullName: "A", postscript: "A", weightClass: 400, italic: false },
      ],
      [{ family: "A", weight: "400", style: "normal", source: "local('A')" }],
    );
    expect(families.map((f) => f.family)).toEqual(["A", "B"]);
    expect(families[0]?.variants).toEqual([
      { weight: "400", style: "normal", source: "local('A'), local('A')" },
      { weight: "400", style: "normal", source: "local('A')" },
      { weight: "400", style: "italic", source: "local('A'), local('A')" },
    ]);
    expect(families[1]?.variants).toHaveLength(1);
  });
});

describe.runIf(win32)("real Windows fonts", () => {
  it("reads the real Arial file", async () => {
    const { parseFileFaces } = await import("./fonts-win");
    const faces = parseFileFaces(join(process.env.SystemRoot ?? "C:\\Windows", "Fonts", "arial.ttf"));
    expect(faces.length).toBeGreaterThan(0);
    expect(faces[0]?.family).toBe("Arial");
  });

  it("lists hundreds of families with CSS-shaped variants", () => {
    const families = listWindowsFonts();
    expect(families.length).toBeGreaterThan(20);
    for (const name of ["Arial", "Times New Roman", "Courier New", "Segoe UI"]) {
      expect(families.map((f) => f.family)).toContain(name);
    }
    const arial = families.find((f) => f.family === "Arial");
    const weights = new Set(arial?.variants.map((v) => v.weight));
    expect(weights.has("400") && weights.has("700")).toBe(true);
    for (const family of families) {
      for (const variant of family.variants) {
        expect(variant.weight).toMatch(/^[1-9]00$/);
        expect(["normal", "italic"]).toContain(variant.style);
        expect(variant.source.startsWith("local('")).toBe(true);
      }
    }
  });
});
