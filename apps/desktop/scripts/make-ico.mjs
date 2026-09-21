/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Builds assets/icon.ico from assets/icon.png without any image tooling: a
// Vista-style icon whose entries are PNG-compressed, i.e. the ICO directory
// points at the PNG bytes verbatim and Windows decodes and scales them. The
// committed .ico is what electron-packager stamps onto the exe (see
// packagerConfig.icon) and what the Squirrel maker uses for Setup.exe, so it
// is generated once and checked in, like icon.icns. Run:
//   node scripts/make-ico.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const png = readFileSync(join(assetsDir, "icon.png"));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!png.subarray(0, 8).equals(PNG_MAGIC)) {
  throw new Error("assets/icon.png is not a PNG file");
}

// Every entry references the same PNG; Windows picks by the nominal size and
// scales. A width/height byte of 0 means 256.
const SIZES = [16, 32, 48, 256];
const header = Buffer.alloc(6 + 16 * SIZES.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(SIZES.length, 4);
SIZES.forEach((size, i) => {
  const off = 6 + 16 * i;
  header.writeUInt8(size === 256 ? 0 : size, off);
  header.writeUInt8(size === 256 ? 0 : size, off + 1);
  header.writeUInt8(0, off + 2); // palette colors
  header.writeUInt8(0, off + 3); // reserved
  header.writeUInt16LE(1, off + 4); // planes
  header.writeUInt16LE(32, off + 6); // bits per pixel
  header.writeUInt32LE(png.length, off + 8);
  header.writeUInt32LE(header.length, off + 12);
});

writeFileSync(join(assetsDir, "icon.ico"), Buffer.concat([header, png]));
console.log(`make-ico: wrote icon.ico (${header.length + png.length} bytes)`);
