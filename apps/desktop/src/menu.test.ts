/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { menuTemplate } from "./menu";

import type { MenuItemConstructorOptions } from "electron";

function roles(items: MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  const walk = (list: MenuItemConstructorOptions[] | { items: MenuItemConstructorOptions[] } | undefined): void => {
    const array = Array.isArray(list) ? list : list?.items;
    if (!array) return;
    for (const item of array) {
      if (typeof item.role === "string") out.push(item.role);
      if (item.submenu) walk(item.submenu as MenuItemConstructorOptions[]);
    }
  };
  walk(items);
  return out;
}

const MACOS_ONLY_ROLES = [
  "about",
  "services",
  "hide",
  "hideOthers",
  "unhide",
  "startSpeaking",
  "stopSpeaking",
  "front",
  "toggleTabBar",
  "selectNextTab",
  "selectPreviousTab",
  "showSubstitutions",
  "toggleSmartQuotes",
  "toggleSmartDashes",
  "toggleTextReplacement",
];

describe("menuTemplate", () => {
  it("keeps the macOS app-menu-first layout", () => {
    const template = menuTemplate("darwin", "Diffusion Studio");
    expect(template[0]?.label).toBe("Diffusion Studio");
    expect(roles(template)).toContain("quit");
    expect(roles(template)).toEqual(expect.arrayContaining(["fileMenu", "editMenu", "viewMenu", "windowMenu"]));
  });

  it("spells File/Edit/View/Window on Windows and Linux with no macOS-only roles", () => {
    for (const platform of ["win32", "linux"] as const) {
      const template = menuTemplate(platform, "Diffusion Studio");
      expect(template.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window"]);
      const used = roles(template);
      for (const role of MACOS_ONLY_ROLES) expect(used, platform).not.toContain(role);
      expect(used).toEqual(
        expect.arrayContaining(["quit", "undo", "cut", "copy", "paste", "reload", "toggleDevTools", "minimize", "close"]),
      );
    }
  });
});
