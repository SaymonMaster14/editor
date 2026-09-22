/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEPTH_IMPORTS, depthPaths, DepthWorker, resolveDepthPython } from "./depth-worker";
import { resolveWorkerPython } from "./model-worker";

// A stand-in for workers/depth.py: stdlib only, no model. Answers
// info/depth/shutdown with a canned 16-bit gradient; cls_id-style, the
// dmin echoes how many PNG bytes arrived.
const STUB = `
import base64, json, sys
DEPTH_2PX = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAAAAACB2fwVAAAADUlEQVQIHWNkYPj/HwADBwIAru6KegAAAABJRU5ErkJggg=="
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    cmd, rid = req.get("cmd"), req.get("id")
    if cmd == "info":
        res = {"id": rid, "ok": True, "model": "stub-depth", "device": "stub"}
    elif cmd == "depth":
        raw = base64.b64decode(req["image_b64"])
        res = {"id": rid, "ok": True, "width": 2, "height": 1, "device": "stub",
               "ms": 2.5, "dmin": float(len(raw)), "dmax": 8.25, "depth_b64": DEPTH_2PX}
    elif cmd == "shutdown":
        print(json.dumps({"id": rid, "ok": True}), flush=True)
        break
    else:
        res = {"id": rid, "ok": False, "error": "unknown cmd %r" % (cmd,)}
        print(json.dumps(res), flush=True)
        continue
    print(json.dumps(res), flush=True)
`;

const DEPTH_2PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAAAAACB2fwVAAAADUlEQVQIHWNkYPj/HwADBwIAru6KegAAAABJRU5ErkJggg==",
  "base64",
);

let stubPath = "";
const python: string[] | null = resolveDepthPython();
const workers: DepthWorker[] = [];

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "depth-stub-"));
  stubPath = join(dir, "stub-worker.py");
  writeFileSync(stubPath, STUB);
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(1000).catch(() => undefined);
});

function start(): DepthWorker {
  const worker = new DepthWorker({
    python: [...python!],
    scriptPath: stubPath,
    modelsDir: mkdtempSync(join(tmpdir(), "depth-models-")),
  });
  workers.push(worker);
  return worker;
}

// Subprocess tests need a real interpreter; windows-latest and macOS CI
// runners ship one, and a machine without Python cannot run depth anyway.
const needsPython = python === null ? it.skip : it;

describe("resolveDepthPython", () => {
  it("asks for the depth imports", () => {
    expect(DEPTH_IMPORTS).toEqual(["transformers", "torch", "cv2"]);
  });

  it("returns null when no candidate answers", () => {
    expect(resolveWorkerPython(DEPTH_IMPORTS, {}, () => false)).toBeNull();
  });

  it("finds this machine's depth-capable interpreter", () => {
    expect(python).not.toBeNull();
  });
});

describe("depthPaths", () => {
  it("points at the bundled worker and the userData models dir when packaged", () => {
    expect(depthPaths({ isPackaged: true, appPath: "/a", resourcesPath: "/r", userData: "/u" })).toEqual({
      scriptPath: join("/r", "workers", "depth.py"),
      modelsDir: join("/u", "models"),
    });
  });
});

describe("DepthWorker", () => {
  needsPython("answers info with the model and device", async () => {
    const worker = start();
    expect(worker.running).toBe(false);
    await expect(worker.info()).resolves.toEqual({ model: "stub-depth", device: "stub" });
    expect(worker.running).toBe(true);
  });

  needsPython("round-trips a depth call with map bytes intact", async () => {
    const worker = start();
    const png = new Uint8Array([9, 8, 7, 6]);
    const res = await worker.depth(png);
    expect(res.width).toBe(2);
    expect(res.height).toBe(1);
    expect(res.device).toBe("stub");
    expect(res.ms).toBe(2.5);
    // dmin echoes how many PNG bytes the stub received: the frame crossed whole.
    expect(res.dmin).toBe(png.length);
    expect(res.dmax).toBe(8.25);
    expect(Buffer.from(res.depth)).toEqual(DEPTH_2PX);
  });

  needsPython("keeps concurrent calls' responses with their requests", async () => {
    const worker = start();
    const [a, b] = await Promise.all([worker.depth(new Uint8Array(5)), worker.depth(new Uint8Array(11))]);
    expect(a.dmin).toBe(5);
    expect(b.dmin).toBe(11);
  });

  needsPython("rejects a malformed depth answer", async () => {
    const worker = start();
    await expect(worker.call({ cmd: "bogus" })).rejects.toThrow("unknown cmd");
  });

  needsPython("stops gracefully on shutdown, and twice safely", async () => {
    const worker = start();
    await worker.info();
    await worker.stop();
    expect(worker.running).toBe(false);
    await worker.stop();
  });
});
