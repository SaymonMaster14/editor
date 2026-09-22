/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The canvas shows an edit before the file has it, and an export and the next
// open render the file: an edit the write left out would move back. So the
// user wins — a prop is written over whatever the source held for it.

import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyEdits } from "./edit";

const FILE = "main.tsx";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "edit-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applyEdits", () => {
  it("writes a prop over a literal and over an expression alike", async () => {
    await writeFile(
      join(dir, FILE),
      `const X = 100;\nexport default () => <video id="clip" x={X} y={20} rotation={ticker() * 2} />;\n`,
    );

    const result = await applyEdits({ dir }, [
      { kind: "set", source: `${FILE}:clip`, props: { x: 555, y: 42, rotation: 90 } },
    ]);

    expect(result.skipped).toEqual([]);
    const text = await readFile(join(dir, FILE), "utf8");
    expect(text).toContain(`<video id="clip" x={555} y={42} rotation={90} />`);
    // The constant is someone else's too, and stays.
    expect(text).toContain(`const X = 100;`);
  });

  it("puts an undo back under the id it had when nothing holds it", async () => {
    await writeFile(
      join(dir, FILE),
      `export default () => (\n  <sequence id="line">\n    <video id="clipA" src="a.mp4" />\n  </sequence>\n);\n`,
    );

    const result = await applyEdits({ dir }, [
      { kind: "insert", source: "pending#1", parent: `${FILE}:line`, tag: "video", props: { id: "clipB", src: "b.mp4" } },
    ]);

    expect(result.skipped).toEqual([]);
    expect(result.ids).toEqual({ "pending#1": `${FILE}:clipB` });
    const text = await readFile(join(dir, FILE), "utf8");
    expect(text).toContain(`id="clipB"`);
  });

  it("mints afresh when the requested id is taken, never doubling it", async () => {
    await writeFile(
      join(dir, FILE),
      `export default () => (\n  <sequence id="line">\n    <video id="clipB" src="b.mp4" />\n  </sequence>\n);\n`,
    );

    const result = await applyEdits({ dir }, [
      { kind: "insert", source: "pending#1", parent: `${FILE}:line`, tag: "video", props: { id: "clipB", src: "b.mp4" } },
    ]);

    expect(result.skipped).toEqual([]);
    const text = await readFile(join(dir, FILE), "utf8");
    expect(text.match(/id="clipB"/g)).toHaveLength(1);
    expect(result.ids?.["pending#1"]).not.toBe(`${FILE}:clipB`);
  });

  it("restores the id when the remove lands in the same write", async () => {
    await writeFile(
      join(dir, FILE),
      `export default () => (\n  <sequence id="line">\n    <video id="clipB" src="b.mp4" />\n  </sequence>\n);\n`,
    );

    // The order the canvas sends them: the insert first, the cut last.
    const result = await applyEdits({ dir }, [
      { kind: "insert", source: "pending#1", parent: `${FILE}:line`, tag: "video", props: { id: "clipB", src: "b.mp4", x: 5 } },
      { kind: "remove", source: `${FILE}:clipB` },
    ]);

    expect(result.skipped).toEqual([]);
    expect(result.ids).toEqual({ "pending#1": `${FILE}:clipB` });
    const text = await readFile(join(dir, FILE), "utf8");
    expect(text.match(/id="clipB"/g)).toHaveLength(1);
    // The survivor is the insert, not the element the cut took.
    expect(text).toContain("x={5}");
  });

});
