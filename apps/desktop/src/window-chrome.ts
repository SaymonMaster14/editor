/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BrowserWindowConstructorOptions } from "electron";

/**
 * The platform-shaped half of the main window options. macOS keeps its
 * inset traffic lights over a transparent vibrancy body; everywhere else
 * the window takes the OS-native frame over the app's dark background.
 * The renderer reads the same platform off `window.desktop` for its own
 * traffic-light spacing, so the two never disagree.
 */
export function chromeOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
      vibrancy: "sidebar",
      backgroundColor: "#00000000",
    };
  }
  return { backgroundColor: "#1c1c1c" };
}
