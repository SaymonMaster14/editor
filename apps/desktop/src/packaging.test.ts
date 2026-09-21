/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const forgeSource = readFileSync(join(desktopDir, "forge.config.ts"), "utf8");

// forge.config.ts loads makers through Electron Forge's own ts-node pipeline,
// so these tests assert on the declared wiring plus the on-disk artifacts the
// makers consume, rather than importing the config module under ESM.

describe("windows packaging wiring", () => {
  it("registers the Squirrel maker for win32 only", () => {
    expect(forgeSource).toContain("@electron-forge/maker-squirrel");
    expect(forgeSource).toContain("new MakerSquirrel(");
    const squirrelBlock = forgeSource.slice(
      forgeSource.indexOf("new MakerSquirrel("),
      forgeSource.indexOf("new MakerZIP("),
    );
    expect(squirrelBlock).toContain("['win32']");
    expect(squirrelBlock).not.toContain("darwin");
  });

  it("keeps macOS makers untouched", () => {
    expect(forgeSource).toContain("new MakerZIP({}, ['darwin'])");
    expect(forgeSource).toContain("new MakerDMG({");
  });

  it("points setupIcon at a committed .ico", () => {
    const match = forgeSource.match(/setupIcon:\s*'([^']+)'/);
    expect(match).not.toBeNull();
    const iconPath = join(desktopDir, match![1]);
    expect(existsSync(iconPath)).toBe(true);
  });

  it("keeps the shared packager icon resolvable on both platforms", () => {
    expect(forgeSource).toContain("icon: './assets/icon'");
    expect(existsSync(join(desktopDir, "assets", "icon.icns"))).toBe(true);
    expect(existsSync(join(desktopDir, "assets", "icon.ico"))).toBe(true);
  });
});

describe("icon.ico", () => {
  const ico = readFileSync(join(desktopDir, "assets", "icon.ico"));
  const png = readFileSync(join(desktopDir, "assets", "icon.png"));

  it("has a valid ICONDIR header", () => {
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // icon, not cursor
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(ico.length).toBeGreaterThan(6 + 16 * count);
  });

  it("embeds the PNG bytes verbatim behind every entry", () => {
    const count = ico.readUInt16LE(4);
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (let i = 0; i < count; i++) {
      const off = 6 + 16 * i;
      const size = ico.readUInt32LE(off + 8);
      const at = ico.readUInt32LE(off + 12);
      expect(ico.subarray(at, at + 8).equals(PNG_MAGIC)).toBe(true);
      expect(ico.subarray(at, at + size).equals(png)).toBe(true);
    }
  });
});

describe("main process squirrel handling", () => {
  const mainSource = readFileSync(join(desktopDir, "src", "main.ts"), "utf8");

  it("handles Squirrel events before the app is ready", () => {
    expect(mainSource).toContain("electron-squirrel-startup");
    const handlerAt = mainSource.indexOf("electron-squirrel-startup");
    expect(mainSource.indexOf("app.whenReady()", handlerAt)).toBeGreaterThan(handlerAt);
  });

  it("sets the Windows AppUserModelID", () => {
    expect(mainSource).toContain('setAppUserModelId("studio.diffusion.editor")');
  });
});
