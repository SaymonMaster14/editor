/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// diffusion:// routing, shared by first launch and second-instance
// delivery: which argv entry is a deep link, whether the launch stays
// hidden, and which consumer a link belongs to.

import { MAIN_CHANNELS } from "./main-channels";

import type { DeepLinkChannel } from "./main-channels";

/** The protocol the app registers with the OS for auth/checkout callbacks. */
export const AUTH_PROTOCOL = "diffusion";

/** The argv entry carrying a deep link, or null when the launch has none. */
export function findProtocolUrl(argv: string[], protocol: string = AUTH_PROTOCOL): string | null {
  return argv.find((arg) => arg.startsWith(`${protocol}://`)) ?? null;
}

/** Whether the launch must stay in the background (dapi bringing up MCP). */
export function isHiddenLaunch(argv: string[]): boolean {
  return argv.includes("--hidden");
}

// diffusion://auth/callback → auth, diffusion://checkout/callback → checkout.
export function deepLinkChannel(url: string): DeepLinkChannel | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  if (host === "auth") return MAIN_CHANNELS.AUTH_CALLBACK;
  if (host === "checkout") return MAIN_CHANNELS.CHECKOUT_CALLBACK;
  return null;
}
