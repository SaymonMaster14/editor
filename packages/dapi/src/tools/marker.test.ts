/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { marker } from "./marker";

describe("marker", () => {
  const input = marker.input;

  it("parses positions in every time form", () => {
    expect(input.parse({ op: "add", at: "45f" }).at).toBe(1.5);
    expect(input.parse({ op: "add", at: "1:10" }).at).toBe(70);
    expect(input.parse({ op: "add", at: 2.5 }).at).toBe(2.5);
    expect(input.parse({ op: "move", from: "30f", to: "0:05" })).toMatchObject({ from: 1, to: 5 });
  });

  it("rejects negative positions", () => {
    expect(input.safeParse({ op: "add", at: -1 }).success).toBe(false);
    expect(input.safeParse({ op: "move", from: 0, to: "-2f" }).success).toBe(false);
  });

  it("rejects unknown ops and directions", () => {
    expect(input.safeParse({ op: "pin" }).success).toBe(false);
    expect(input.safeParse({ op: "seek", direction: "sideways" }).success).toBe(false);
    expect(input.parse({ op: "seek", direction: "next" }).direction).toBe("next");
  });

  it("leaves optionals unset", () => {
    const args = input.parse({ op: "list" });
    expect(args.at).toBeUndefined();
    expect(args.name).toBeUndefined();
    expect(args.color).toBeUndefined();
    expect(args.direction).toBeUndefined();
  });
});
