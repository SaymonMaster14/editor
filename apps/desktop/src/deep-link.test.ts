/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { deepLinkChannel, findProtocolUrl, isHiddenLaunch } from "./deep-link";
import { MAIN_CHANNELS } from "./main-channels";

describe("findProtocolUrl", () => {
  it("finds the deep link among exe paths and flags", () => {
    const argv = ["C:\\Program Files\\Diffusion Studio\\Diffusion Studio.exe", "--foo", "diffusion://auth/callback?x=1"];
    expect(findProtocolUrl(argv)).toBe("diffusion://auth/callback?x=1");
  });

  it("returns null without one, and ignores other protocols", () => {
    expect(findProtocolUrl(["C:\\app.exe", "--hidden"])).toBeNull();
    expect(findProtocolUrl(["https://diffusionstudio.io/diffusion://x"])).toBeNull();
  });
});

describe("isHiddenLaunch", () => {
  it("is true exactly when --hidden is passed", () => {
    expect(isHiddenLaunch(["app.exe", "--hidden"])).toBe(true);
    expect(isHiddenLaunch(["app.exe", "--foo", "diffusion://auth/x"])).toBe(false);
  });
});

describe("deepLinkChannel", () => {
  it("routes auth and checkout by host", () => {
    expect(deepLinkChannel("diffusion://auth/callback?code=abc")).toBe(MAIN_CHANNELS.AUTH_CALLBACK);
    expect(deepLinkChannel("diffusion://checkout/callback")).toBe(MAIN_CHANNELS.CHECKOUT_CALLBACK);
  });

  it("rejects unknown hosts and malformed links without throwing", () => {
    expect(deepLinkChannel("diffusion://settings/page")).toBeNull();
    expect(deepLinkChannel("diffusion://")).toBeNull();
    expect(deepLinkChannel("not a url")).toBeNull();
    expect(deepLinkChannel("")).toBeNull();
  });
});
