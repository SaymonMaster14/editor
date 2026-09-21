/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { chromeOptions } from "./window-chrome";

describe("chromeOptions", () => {
  it("keeps the macOS inset traffic lights over vibrancy", () => {
    expect(chromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
      vibrancy: "sidebar",
      backgroundColor: "#00000000",
    });
  });

  it("leaves the native frame alone on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const options = chromeOptions(platform);
      expect(options).toEqual({ backgroundColor: "#1c1c1c" });
      expect("titleBarStyle" in options).toBe(false);
      expect("trafficLightPosition" in options).toBe(false);
      expect("vibrancy" in options).toBe(false);
    }
  });
});
