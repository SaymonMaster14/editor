/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolvePython, segmentPaths, SegmentWorker } from "./segment-worker";

// A stand-in for workers/segment.py: stdlib only, no model. Modes:
//   ok       — answers info/segment/shutdown with canned detections
//   crash    — exits(3) on its second request, to prove restart
//   stubborn — reads requests and never answers or exits, to prove kill
const stubSource = (mode: string) => `
import base64, json, sys
mode = ${JSON.stringify(mode)}
MASK_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJ5CYII="
seen = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    seen += 1
    if mode == "crash" and seen == 2:
        sys.exit(3)
    if mode == "stubborn":
        continue
    cmd, rid = req.get("cmd"), req.get("id")
    if cmd == "info":
        res = {"id": rid, "ok": True, "model": "stub-seg", "device": "stub", "classes": ["person", "bus"]}
    elif cmd == "segment":
        if req.get("classes") == ["nope"]:
            res = {"id": rid, "ok": False, "error": "unknown classes: nope"}
        else:
            raw = base64.b64decode(req["image_b64"])
            tag = "second" if req.get("conf", 0) > 0.5 else "first"
            res = {"id": rid, "ok": True, "width": 4, "height": 3, "device": "stub", "ms": 1.5, "detections": [
                {"cls": tag, "cls_id": len(raw), "conf": 0.9, "bbox": [0, 0, 4, 3],
                 "area": 12, "mask_b64": MASK_1PX, "extra": "dropped"}]}
    elif cmd == "shutdown":
        print(json.dumps({"id": rid, "ok": True}), flush=True)
        break
    else:
        res = {"id": rid, "ok": False, "error": "unknown cmd %r" % (cmd,)}
        print(json.dumps(res), flush=True)
        continue
    print(json.dumps(res), flush=True)
`;

const MASK_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJ5CYII=",
  "base64",
);

let stubDir = "";
// Resolved at collection: the runIf below decides from it.
const python: string[] | null = resolvePython();
const workers: SegmentWorker[] = [];

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "segment-stub-"));
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(1000).catch(() => undefined);
});

function start(mode = "ok"): SegmentWorker {
  const scriptPath = join(stubDir, `stub-worker-${mode}.py`);
  writeFileSync(scriptPath, stubSource(mode));
  const worker = new SegmentWorker({
    python: [...python!],
    scriptPath,
    modelsDir: mkdtempSync(join(tmpdir(), "segment-models-")),
  });
  workers.push(worker);
  return worker;
}

// Subprocess tests need a real interpreter; windows-latest and macOS CI
// runners ship one, and a machine without Python cannot segment anyway.
const needsPython = python === null ? it.skip : it;

describe("resolvePython", () => {
  it("honors DIFFUSION_STUDIO_PYTHON over everything else", () => {
    const seen: string[] = [];
    const found = resolvePython({ DIFFUSION_STUDIO_PYTHON: "C:\\custom\\python.exe" }, (command, _args) => {
      seen.push(command);
      return true;
    });
    expect(found).toEqual(["C:\\custom\\python.exe"]);
    expect(seen).toEqual(["C:\\custom\\python.exe"]);
  });

  it("returns null when no candidate answers", () => {
    expect(resolvePython({}, () => false)).toBeNull();
  });

  it("skips an interpreter that exists but cannot run the worker", () => {
    const found = resolvePython({}, (command) => command !== "py");
    expect(found?.[0]).not.toBe("py");
  });

  it("rejects an override that cannot run the worker", () => {
    expect(() => resolvePython({ DIFFUSION_STUDIO_PYTHON: "C:\\bare\\python.exe" }, () => false)).toThrow(
      /DIFFUSION_STUDIO_PYTHON points at/,
    );
  });

  it("finds this machine's ML-capable interpreter", () => {
    expect(python).not.toBeNull();
  });
});

describe("segmentPaths", () => {
  it("points at the bundled worker and the userData models dir when packaged", () => {
    expect(segmentPaths({ isPackaged: true, appPath: "/a", resourcesPath: "/r", userData: "/u" })).toEqual({
      scriptPath: join("/r", "workers", "segment.py"),
      modelsDir: join("/u", "models"),
    });
  });

  it("points at the repo worker in development", () => {
    expect(segmentPaths({ isPackaged: false, appPath: "/a", resourcesPath: "/r", userData: "/u" })).toEqual({
      scriptPath: join("/a", "workers", "segment.py"),
      modelsDir: join("/u", "models"),
    });
  });
});

describe("SegmentWorker", () => {
  needsPython("answers info with the model, device, and classes", async () => {
    const worker = start();
    expect(worker.running).toBe(false);
    await expect(worker.info()).resolves.toEqual({ model: "stub-seg", device: "stub", classes: ["person", "bus"] });
    expect(worker.running).toBe(true);
  });

  needsPython("round-trips a segment call with mask bytes intact", async () => {
    const worker = start();
    const png = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await worker.segment(png, { classes: ["person"], conf: 0.5 });
    expect(res.width).toBe(4);
    expect(res.height).toBe(3);
    expect(res.device).toBe("stub");
    expect(res.detections).toHaveLength(1);
    const [det] = res.detections;
    // cls_id carries how many PNG bytes the stub received: the frame crossed whole.
    expect(det).toMatchObject({ cls: "first", cls_id: png.length, conf: 0.9, bbox: [0, 0, 4, 3], area: 12 });
    expect(Buffer.from(det!.mask)).toEqual(MASK_1PX);
    // Unknown worker fields are dropped: the driver returns the documented shape.
    expect("extra" in det!).toBe(false);
  });

  needsPython("keeps concurrent calls' responses with their requests", async () => {
    const worker = start();
    const [a, b] = await Promise.all([
      worker.segment(new Uint8Array(7), { conf: 0.1 }),
      worker.segment(new Uint8Array(13), { conf: 0.9 }),
    ]);
    // The stub tags each reply from that call's own conf: crossed wires would swap these.
    expect(a.detections[0]).toMatchObject({ cls: "first", cls_id: 7 });
    expect(b.detections[0]).toMatchObject({ cls: "second", cls_id: 13 });
  });

  needsPython("surfaces worker errors with their message", async () => {
    const worker = start();
    await expect(worker.segment(new Uint8Array(3), { classes: ["nope"] })).rejects.toThrow("unknown classes: nope");
  });

  needsPython("fails the in-flight call when the worker dies, then restarts lazily", async () => {
    const worker = start("crash");
    await expect(worker.info()).resolves.toBeTruthy();
    await expect(worker.segment(new Uint8Array(3))).rejects.toThrow(/exited with code 3/);
    expect(worker.running).toBe(false);
    await expect(worker.info()).resolves.toBeTruthy();
    expect(worker.running).toBe(true);
  });

  needsPython("stops gracefully on shutdown, and twice safely", async () => {
    const worker = start();
    await worker.info();
    await worker.stop();
    expect(worker.running).toBe(false);
    await worker.stop();
  });

  needsPython("kills a worker that ignores shutdown", async () => {
    const worker = start("stubborn");
    // Spawn it without awaiting a reply that never comes.
    const pending = worker.info();
    pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await worker.stop(300);
    expect(worker.running).toBe(false);
    await expect(pending).rejects.toThrow();
  });
});
