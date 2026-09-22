/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FLOW_IMPORTS, flowPaths, FlowWorker, resolveFlowPython } from "./flow-worker";
import { resolveWorkerPython } from "./model-worker";

// A stand-in for workers/flow.py: stdlib only, no model. Answers
// info/flow/shutdown with a canned field; the mean_mag echoes how many
// bytes the two frames held together, so the test sees both crossed.
const STUB = `
import base64, json, sys
FLOW_4B = "AAMHAAGIQQAA"
PREV_2PX = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAAAAACB2fwVAAAADUlEQVQIHWNkYPj/HwADBwIAru6KegAAAABJRU5ErkJggg=="
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    cmd, rid = req.get("cmd"), req.get("id")
    if cmd == "info":
        res = {"id": rid, "ok": True, "model": "stub-flow", "device": "stub",
               "engines": ["dis", "raft"]}
    elif cmd == "flow":
        a = base64.b64decode(req["image_a_b64"])
        b = base64.b64decode(req["image_b_b64"])
        res = {"id": rid, "ok": True, "width": 2, "height": 1, "device": "stub",
               "engine": req.get("engine", "raft"), "ms": 3.5,
               "mean_mag": float(len(a) + len(b)), "p95_mag": 9.81,
               "flow_b64": FLOW_4B, "preview_b64": PREV_2PX}
    elif cmd == "shutdown":
        print(json.dumps({"id": rid, "ok": True}), flush=True)
        break
    else:
        res = {"id": rid, "ok": False, "error": "unknown cmd %r" % (cmd,)}
        print(json.dumps(res), flush=True)
        continue
    print(json.dumps(res), flush=True)
`;

const FLOW_4B = Buffer.from("AAMHAAGIQQAA", "base64");

const PREV_2PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAAAAACB2fwVAAAADUlEQVQIHWNkYPj/HwADBwIAru6KegAAAABJRU5ErkJggg==",
  "base64",
);

let stubPath = "";
const python: string[] | null = resolveFlowPython();
const workers: FlowWorker[] = [];

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "flow-stub-"));
  stubPath = join(dir, "stub-worker.py");
  writeFileSync(stubPath, STUB);
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(1000).catch(() => undefined);
});

function start(): FlowWorker {
  const worker = new FlowWorker({
    python: [...python!],
    scriptPath: stubPath,
    modelsDir: mkdtempSync(join(tmpdir(), "flow-models-")),
  });
  workers.push(worker);
  return worker;
}

// Subprocess tests need a real interpreter; windows-latest and macOS CI
// runners ship one, and a machine without Python cannot run flow anyway.
const needsPython = python === null ? it.skip : it;

describe("resolveFlowPython", () => {
  it("asks for the flow imports", () => {
    expect(FLOW_IMPORTS).toEqual(["torch", "torchvision", "cv2"]);
  });

  it("returns null when no candidate answers", () => {
    expect(resolveWorkerPython(FLOW_IMPORTS, {}, () => false)).toBeNull();
  });

  it("finds this machine's flow-capable interpreter", () => {
    expect(python).not.toBeNull();
  });
});

describe("flowPaths", () => {
  it("points at the bundled worker and the userData models dir when packaged", () => {
    expect(flowPaths({ isPackaged: true, appPath: "/a", resourcesPath: "/r", userData: "/u" })).toEqual({
      scriptPath: join("/r", "workers", "flow.py"),
      modelsDir: join("/u", "models"),
    });
  });
});

describe("FlowWorker", () => {
  needsPython("answers info with the model, device, and engines", async () => {
    const worker = start();
    expect(worker.running).toBe(false);
    await expect(worker.info()).resolves.toEqual({ model: "stub-flow", device: "stub", engines: ["dis", "raft"] });
    expect(worker.running).toBe(true);
  });

  needsPython("round-trips a flow call with field and preview bytes intact", async () => {
    const worker = start();
    const pngA = new Uint8Array([9, 8, 7, 6]);
    const pngB = new Uint8Array([1, 2, 3]);
    const res = await worker.flow(pngA, pngB, "dis");
    expect(res.width).toBe(2);
    expect(res.height).toBe(1);
    expect(res.device).toBe("stub");
    expect(res.engine).toBe("dis");
    expect(res.ms).toBe(3.5);
    // mean_mag echoes the two frames' combined bytes: both crossed whole.
    expect(res.meanMag).toBe(pngA.length + pngB.length);
    expect(res.p95Mag).toBe(9.81);
    expect(Buffer.from(res.flow)).toEqual(FLOW_4B);
    expect(Buffer.from(res.preview)).toEqual(PREV_2PX);
  });

  needsPython("defaults to the raft engine", async () => {
    const worker = start();
    const res = await worker.flow(new Uint8Array(4), new Uint8Array(4));
    expect(res.engine).toBe("raft");
  });

  needsPython("keeps concurrent calls' responses with their requests", async () => {
    const worker = start();
    const [a, b] = await Promise.all([
      worker.flow(new Uint8Array(5), new Uint8Array(1)),
      worker.flow(new Uint8Array(11), new Uint8Array(1)),
    ]);
    expect(a.meanMag).toBe(6);
    expect(b.meanMag).toBe(12);
  });

  needsPython("rejects a malformed flow answer", async () => {
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
