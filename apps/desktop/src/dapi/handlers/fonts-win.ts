/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Windows local font enumeration. The installed set comes from the Fonts
// registry keys (machine hive plus the current user's, so per-user installs
// show up); each file's real family, weight and italic flag come from its
// own sfnt tables — the same facts DirectWrite, and so Chromium, reads.
// Files whose tables cannot be read (raster .fon, odd formats) fall back to
// their registry display name so the family still shows up, with the weight
// guessed from the style words.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { FontFamily } from "@diffusionstudio/dapi";

/** One font face as its sfnt tables describe it. */
export type WindowsFontFace = {
  family: string;
  fullName: string;
  postscript: string;
  weightClass: number;
  italic: boolean;
};

/**
 * Random access over a font file, so hundred-megabyte collections parse by
 * reading only their headers and name tables instead of loading whole.
 */
export type FontReader = {
  size: number;
  read(offset: number, length: number): Buffer;
};

export function bufferReader(buffer: Buffer): FontReader {
  return { size: buffer.length, read: (offset, length) => buffer.subarray(offset, offset + length) };
}

/** A bounded slice, or null when the tables point outside the file. */
function slice(reader: FontReader, offset: number, length: number): Buffer | null {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || length > 8 * 1024 * 1024) {
    return null;
  }
  if (offset + length > reader.size) return null;
  try {
    return reader.read(offset, length);
  } catch {
    return null;
  }
}

/** Every face in a .ttf/.otf, or in each member of a .ttc; [] for anything else. */
export function parseReader(reader: FontReader): WindowsFontFace[] {
  const faces: WindowsFontFace[] = [];
  const header = slice(reader, 0, 12);
  if (!header) return faces;
  if (header.toString("ascii", 0, 4) === "ttcf") {
    const numFonts = header.readUInt32BE(8);
    if (numFonts < 1 || numFonts > 64) return faces;
    const offsets = slice(reader, 12, numFonts * 4);
    if (!offsets) return faces;
    for (let i = 0; i < numFonts; i++) {
      const face = parseSfnt(reader, offsets.readUInt32BE(i * 4));
      if (face) faces.push(face);
    }
    return faces;
  }
  const face = parseSfnt(reader, 0);
  if (face) faces.push(face);
  return faces;
}

/** The one face of a plain sfnt at `offset`, or null when it is not one. */
function parseSfnt(reader: FontReader, offset: number): WindowsFontFace | null {
  const header = slice(reader, offset, 12);
  if (!header) return null;
  const magic = header.readUInt32BE(0);
  if (magic !== 0x00010000 && magic !== 0x4f54544f && magic !== 0x74727565 && magic !== 0x74797031) return null;
  const numTables = header.readUInt16BE(4);
  if (numTables < 1 || numTables > 64) return null;
  const directory = slice(reader, offset + 12, numTables * 16);
  if (!directory) return null;
  let name: { offset: number; length: number } | null = null;
  let os2: { offset: number; length: number } | null = null;
  let head: { offset: number; length: number } | null = null;
  for (let i = 0; i < numTables; i++) {
    const tag = directory.toString("ascii", i * 16, i * 16 + 4);
    const entry = { offset: directory.readUInt32BE(i * 16 + 8), length: directory.readUInt32BE(i * 16 + 12) };
    if (tag === "name") name = entry;
    else if (tag === "OS/2") os2 = entry;
    else if (tag === "head") head = entry;
  }
  const nameBuf = name ? slice(reader, name.offset, name.length) : null;
  if (!nameBuf) return null;
  const names = parseNameTable(nameBuf);
  const family = names.get(16) ?? names.get(1);
  if (!family) return null;
  const subfamily = names.get(17) ?? names.get(2) ?? "";
  const fullName = names.get(4) ?? (subfamily ? `${family} ${subfamily}` : family);
  const postscript = names.get(6) ?? fullName;
  let weightClass = 400;
  const os2Buf = os2 ? slice(reader, os2.offset, os2.length) : null;
  if (os2Buf && os2Buf.length >= 6) weightClass = os2Buf.readUInt16BE(4);
  let italic = /italic|oblique/i.test(subfamily);
  const headBuf = head ? slice(reader, head.offset, head.length) : null;
  // macStyle lives at 44 (offset 16 is flags, whose low bits look italic on
  // nearly every font); bit 1 there means italic.
  if (headBuf && headBuf.length >= 46 && (headBuf.readUInt16BE(44) & 0x02) !== 0) italic = true;
  return { family, fullName, postscript, weightClass, italic };
}

/**
 * nameID to text for the IDs we need (1/2 family/subfamily, 4/6 full and
 * PostScript names, 16/17 typographic overrides), preferring the Windows
 * Unicode US-English record the way DirectWrite does.
 */
function parseNameTable(buf: Buffer): Map<number, string> {
  const out = new Map<number, string>();
  if (buf.length < 6) return out;
  const count = buf.readUInt16BE(2);
  const stringOffset = buf.readUInt16BE(4);
  const rank = (platform: number, encoding: number, language: number): number => {
    if (platform === 3 && encoding === 1) return language === 0x409 ? 0 : 1;
    if (platform === 0) return 2;
    if (platform === 1 && encoding === 0) return 3;
    return 9;
  };
  const decoder = new TextDecoder("utf-16be");
  const best = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 12;
    if (base + 12 > buf.length) break;
    const platform = buf.readUInt16BE(base);
    const encoding = buf.readUInt16BE(base + 2);
    const language = buf.readUInt16BE(base + 4);
    const id = buf.readUInt16BE(base + 6);
    if (id !== 1 && id !== 2 && id !== 4 && id !== 6 && id !== 16 && id !== 17) continue;
    const length = buf.readUInt16BE(base + 8);
    const start = stringOffset + buf.readUInt16BE(base + 10);
    if (start + length > buf.length) continue;
    const r = rank(platform, encoding, language);
    if (r >= 9 || (best.get(id) ?? 10) <= r) continue;
    const raw = buf.subarray(start, start + length);
    const text = platform === 1 ? raw.toString("latin1") : decoder.decode(raw);
    if (text === "") continue;
    out.set(id, text);
    best.set(id, r);
  }
  return out;
}

/** Faces from a file on disk; [] when it cannot be opened or is not a font. */
export function parseFileFaces(path: string): WindowsFontFace[] {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const handle = fd;
    return parseReader({
      size,
      read: (offset, length) => {
        const buf = Buffer.alloc(length);
        if (readSync(handle, buf, 0, length, offset) !== length) throw new RangeError("short read");
        return buf;
      },
    });
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore — the parse result stands on its own
      }
    }
  }
}

/** usWeightClass (1-1000) to a CSS hundred. */
export function cssWeight(weightClass: number): string {
  if (!Number.isFinite(weightClass)) return "400";
  return String(Math.min(900, Math.max(100, Math.round(weightClass / 100) * 100)));
}

// --- registry ---------------------------------------------------------------

export type RegistryFont = { name: string; file: string };

const LIST_FONTS_PS = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
  "$entries = @()",
  "foreach ($hive in 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts') {",
  "  if (-not (Test-Path $hive)) { continue }",
  "  foreach ($prop in (Get-ItemProperty -Path $hive).PSObject.Properties) {",
  "    if ($prop.Name -like 'PS*') { continue }",
  "    $entries += [pscustomobject]@{ name = $prop.Name; file = [string]$prop.Value }",
  "  }",
  "}",
  "ConvertTo-Json -InputObject $entries -Compress -Depth 2",
].join("\n");

type SpawnSyncFn = (
  command: string,
  args: string[],
  opts: { encoding: "utf8"; maxBuffer: number },
) => { status: number | null; stdout: string; stderr: string; error?: Error };

export function parseRegistryJson(stdout: string): RegistryFont[] {
  const text = stdout.trim();
  if (text === "") return [];
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: RegistryFont[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { name, file } = item as Record<string, unknown>;
    if (typeof name === "string" && typeof file === "string" && name !== "" && file !== "") out.push({ name, file });
  }
  return out;
}

function readFontRegistry(spawn: SpawnSyncFn = spawnSync): RegistryFont[] {
  const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", LIST_FONTS_PS], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to enumerate fonts.");
  return parseRegistryJson(result.stdout);
}

// --- display-name fallback ----------------------------------------------------

/** "Arial Bold (TrueType)" to "Arial Bold". */
export function stripFontKind(display: string): string {
  return display.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

const WEIGHT_WORDS: Array<[RegExp, string]> = [
  [/^thin$/i, "100"],
  [/^(extralight|ultralight)$/i, "200"],
  [/^light$/i, "300"],
  [/^(regular|normal|book)$/i, "400"],
  [/^medium$/i, "500"],
  [/^(semibold|demibold)$/i, "600"],
  [/^bold$/i, "700"],
  [/^(extrabold|ultrabold)$/i, "800"],
  [/^(black|heavy)$/i, "900"],
];

const ITALIC_WORD = /^(italic|oblique)$/i;

/**
 * family/weight/style from a registry display name, for files whose tables
 * we cannot read. Trailing style words ("Bold Italic") split off; anything
 * else ("Times New Roman", "Segoe UI Variable") stays part of the family.
 */
export function variantFromDisplayName(display: string): {
  family: string;
  weight: string;
  style: "normal" | "italic";
} | null {
  const tokens = stripFontKind(display).split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return null;
  let weight = "400";
  let style: "normal" | "italic" = "normal";
  let end = tokens.length;
  while (end > 1) {
    const token = tokens[end - 1] as string;
    if (ITALIC_WORD.test(token)) {
      style = "italic";
      end--;
      continue;
    }
    const hit = WEIGHT_WORDS.find(([re]) => re.test(token));
    if (!hit) break;
    weight = hit[1];
    end--;
  }
  return { family: tokens.slice(0, end).join(" "), weight, style };
}

// --- assembly -----------------------------------------------------------------

function resolveFontFile(value: string, dirs: string[]): string | null {
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) return value;
  for (const dir of dirs) {
    const candidate = join(dir, value);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export type FallbackVariant = { family: string; weight: string; style: "normal" | "italic"; source: string };

/** Faces and fallbacks grouped into families, variants deduped, everything sorted. */
export function groupFamilies(faces: WindowsFontFace[], fallbacks: FallbackVariant[] = []): FontFamily[] {
  const byFamily = new Map<string, Map<string, { weight: string; style: "normal" | "italic"; source: string }>>();
  const add = (family: string, variant: { weight: string; style: "normal" | "italic"; source: string }): void => {
    let variants = byFamily.get(family);
    if (!variants) {
      variants = new Map();
      byFamily.set(family, variants);
    }
    variants.set(`${variant.weight}|${variant.style}|${variant.source}`, variant);
  };
  for (const face of faces) {
    add(face.family, {
      weight: cssWeight(face.weightClass),
      style: face.italic ? "italic" : "normal",
      source: `local('${face.fullName}'), local('${face.postscript}')`,
    });
  }
  for (const fallback of fallbacks) {
    add(fallback.family, { weight: fallback.weight, style: fallback.style, source: fallback.source });
  }
  return [...byFamily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([family, variants]) => ({
      family,
      variants: [...variants.values()].sort(
        (a, b) => a.weight.localeCompare(b.weight) || (a.style === b.style ? 0 : a.style === "normal" ? -1 : 1),
      ),
    }));
}

function defaultFontDirs(): string[] {
  const dirs = [join(process.env.SystemRoot ?? "C:\\Windows", "Fonts")];
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
  return dirs;
}

/**
 * Registry entries to families: each file parsed once (entries starting
 * with "@" are East Asian vertical aliases of a file already listed),
 * unparseable files guessed from their display name.
 */
export function listWindowsFontsFromEntries(
  entries: RegistryFont[],
  opts: { readFaces?: (path: string) => WindowsFontFace[]; fontDirs?: string[] } = {},
): FontFamily[] {
  const readFaces = opts.readFaces ?? parseFileFaces;
  const fontDirs = opts.fontDirs ?? defaultFontDirs();
  const seenFiles = new Set<string>();
  const faces: WindowsFontFace[] = [];
  const fallbacks: FallbackVariant[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith("@")) continue;
    const path = resolveFontFile(entry.file, fontDirs);
    if (path) {
      const key = path.toLowerCase();
      if (!seenFiles.has(key)) {
        seenFiles.add(key);
        const parsed = readFaces(path);
        if (parsed.length > 0) {
          faces.push(...parsed);
          continue;
        }
      } else {
        continue;
      }
    }
    const guessed = variantFromDisplayName(entry.name);
    if (guessed) fallbacks.push({ ...guessed, source: `local('${stripFontKind(entry.name)}')` });
  }
  return groupFamilies(faces, fallbacks);
}

/** Every installed family: the registry set, resolved through the real files. */
export function listWindowsFonts(opts: { spawn?: SpawnSyncFn; fontDirs?: string[] } = {}): FontFamily[] {
  return listWindowsFontsFromEntries(readFontRegistry(opts.spawn ?? spawnSync), { fontDirs: opts.fontDirs });
}
