"""Dense optical-flow worker (Phase U-tier follow-up, tier 1).

A stdio NDJSON subprocess: the Electron main process spawns it, sends one
JSON request per line on stdin, and reads one JSON response per line on
stdout. Stderr is diagnostics only — stdout stays protocol-clean.

Protocol:
  -> {"id": 1, "cmd": "info"}
  <- {"id": 1, "ok": true, "model": "raft-small/dis-medium",
      "device": "cuda:0", "engines": ["dis", "raft"]}

  -> {"id": 2, "cmd": "flow", "image_a_b64": "<png>", "image_b_b64": "<png>",
      "engine": "raft"}
  <- {"id": 2, "ok": true, "width": W, "height": H, "device": "cuda:0",
      "engine": "raft", "ms": 812.5, "mean_mag": 3.42, "p95_mag": 9.81,
      "flow_b64": "<npy float32 HxWx2, pixel units>",
      "preview_b64": "<Middlebury-viz png, WxH>"}

  -> {"id": 3, "cmd": "shutdown"}
  <- {"id": 3, "ok": true}   (then the process exits 0)

Errors: {"id": N, "ok": false, "error": "<message>"}.

The flow field maps each pixel of frame A to its displacement in frame B,
in pixels of the analyzed (capped) frames: out[y, x] = (dx, dy). The .npy
keeps full float precision for stabilization, retiming, and motion masks;
mean_mag/p95_mag summarize motion strength for agent thresholds. The
preview is Middlebury color-wheel visualization, for eyes only.

Engines: "dis" is OpenCV DIS (CPU, instant, no weights); "raft" is
torchvision RAFT-small (CUDA when available, CPU fallback). RAFT weights
(~20 MB, BSD-style torchvision license) download on first use into the
torch hub cache, which the spawner points at the app's models dir
(TORCH_HOME), so nothing lands in the user's global cache.

Stdout is responses only — torch/hub chatter goes to stderr.
"""

import base64
import io
import json
import sys
import time

RESPONSE_SCHEMA_VERSION = 1


def log(message):
    print(f"[flow-worker] {message}", file=sys.stderr, flush=True)


def fail(request_id, message):
    return {"id": request_id, "ok": False, "error": str(message)}


def middlebury(flow):
    """Standard Middlebury color-wheel visualization, BGR uint8."""
    import numpy as np

    rad = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2)
    ang = np.arctan2(-flow[..., 1], -flow[..., 0]) / np.pi  # -1..1
    n = 55
    wheel = np.zeros((n, 3), np.float32)
    segs = [15, 6, 4, 11, 13, 6]
    cols = [(255, 0, 0), (255, 255, 0), (0, 255, 0), (0, 255, 255), (0, 0, 255), (255, 0, 255)]
    k = 0
    for j, (ncols, (r0, g0, b0)) in enumerate(zip(segs, cols)):
        r1, g1, b1 = cols[(j + 1) % len(cols)]
        for i in range(ncols):
            f = i / ncols
            wheel[k] = (r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f)
            k += 1
    fk = (ang + 1) / 2 * (n - 1) + 1
    k0 = np.floor(fk).astype(np.int32)
    k1 = k0 + 1
    k1[k1 == n + 1] = 1
    f = fk - k0
    vis = np.empty((*rad.shape, 3), np.float32)
    sat = rad / (rad + 1)
    for i in range(3):
        c0 = wheel[k0 - 1, i] / 255.0
        c1 = wheel[k1 - 1, i] / 255.0
        vis[..., i] = (1 - sat) * 1.0 + sat * ((1 - f) * c0 + f * c1)
    return (vis[..., ::-1] * 255).astype(np.uint8)


class FlowWorker:
    def __init__(self):
        self.raft_model = None
        self.raft_prep = None
        self.device = None

    def ensure_raft(self):
        if self.raft_model is not None:
            return
        import torch
        from torchvision.models.optical_flow import Raft_Small_Weights, raft_small

        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        log(f"loading raft-small on {self.device}")
        started = time.perf_counter()
        # Weights resolve through TORCH_HOME, which the spawner points at
        # the app's models dir; first run downloads there (~20 MB).
        weights = Raft_Small_Weights.DEFAULT
        self.raft_model = raft_small(weights=weights, progress=False).to(self.device).eval()
        self.raft_prep = weights.transforms()
        log(f"model ready in {(time.perf_counter() - started) * 1000:.0f} ms")

    def info(self, request_id):
        import torch

        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        return {
            "id": request_id,
            "ok": True,
            "schema": RESPONSE_SCHEMA_VERSION,
            "model": "raft-small/dis-medium",
            "device": device,
            "engines": ["dis", "raft"],
        }

    def decode_frame(self, req, key):
        import cv2
        import numpy as np

        raw = req.get(key)
        if not isinstance(raw, str) or not raw:
            return None, f"flow needs {key} (base64 png)"
        try:
            blob = base64.b64decode(raw)
        except Exception as exc:
            return None, f"{key} is not valid base64: {exc}"
        try:
            image = cv2.imdecode(np.frombuffer(blob, np.uint8), cv2.IMREAD_COLOR)
        except Exception:
            image = None
        if image is None:
            return None, f"{key} did not decode to an image"
        return image, None

    def flow_dis(self, a, b):
        import cv2

        gray_a = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
        gray_b = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
        dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        started = time.perf_counter()
        flow = dis.calc(gray_a, gray_b, None)
        return flow, (time.perf_counter() - started) * 1000, "cpu"

    def flow_raft(self, a, b):
        import cv2
        import numpy as np
        import torch

        self.ensure_raft()
        rgb_a = cv2.cvtColor(a, cv2.COLOR_BGR2RGB)
        rgb_b = cv2.cvtColor(b, cv2.COLOR_BGR2RGB)
        ta = torch.from_numpy(np.ascontiguousarray(rgb_a)).permute(2, 0, 1).unsqueeze(0).to(self.device)
        tb = torch.from_numpy(np.ascontiguousarray(rgb_b)).permute(2, 0, 1).unsqueeze(0).to(self.device)
        ta, tb = self.raft_prep(ta, tb)
        # RAFT downsamples 8x: pad to multiples of 8, crop the field back.
        _, _, h, w = ta.shape
        pad_h = (8 - h % 8) % 8
        pad_w = (8 - w % 8) % 8
        if pad_h or pad_w:
            import torch.nn.functional as F

            ta = F.pad(ta, (0, pad_w, 0, pad_h))
            tb = F.pad(tb, (0, pad_w, 0, pad_h))
        started = time.perf_counter()
        with torch.inference_mode():
            pred = self.raft_model(ta, tb)[-1]
            if self.device.startswith("cuda"):
                torch.cuda.synchronize()
        ms = (time.perf_counter() - started) * 1000
        pred = pred[:, :, :h, :w]
        flow = pred[0].detach().cpu().numpy().transpose(1, 2, 0).astype(np.float32)
        return flow, ms, self.device

    def flow(self, req):
        import cv2
        import numpy as np

        request_id = req.get("id")
        engine = req.get("engine", "raft")
        if engine not in ("dis", "raft"):
            return fail(request_id, f"unknown engine {engine!r} (dis, raft)")

        a, err = self.decode_frame(req, "image_a_b64")
        if err:
            return fail(request_id, err)
        b, err = self.decode_frame(req, "image_b_b64")
        if err:
            return fail(request_id, err)
        if a.shape != b.shape:
            return fail(request_id, f"frames differ in size: {a.shape} vs {b.shape}")
        h, w = a.shape[:2]

        if engine == "dis":
            flow, ms, device = self.flow_dis(a, b)
        else:
            flow, ms, device = self.flow_raft(a, b)
        flow = np.ascontiguousarray(flow, dtype=np.float32)

        mag = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2)
        buf = io.BytesIO()
        np.save(buf, flow)
        ok, png = cv2.imencode(".png", middlebury(flow))
        if not ok:
            return fail(request_id, "flow preview encoding failed")
        return {
            "id": request_id,
            "ok": True,
            "width": w,
            "height": h,
            "device": device,
            "engine": engine,
            "ms": round(ms, 1),
            "mean_mag": round(float(mag.mean()), 3),
            "p95_mag": round(float(np.percentile(mag, 95)), 3),
            "flow_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
            "preview_b64": base64.b64encode(png.tobytes()).decode("ascii"),
        }


def main():
    worker = FlowWorker()
    stdin = sys.stdin
    stdout = sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            stdout.write(json.dumps(fail(None, f"invalid json: {exc}")) + "\n")
            stdout.flush()
            continue
        request_id = req.get("id")
        cmd = req.get("cmd")
        try:
            if cmd == "info":
                res = worker.info(request_id)
            elif cmd == "flow":
                res = worker.flow(req)
            elif cmd == "shutdown":
                res = {"id": request_id, "ok": True}
                stdout.write(json.dumps(res) + "\n")
                stdout.flush()
                return 0
            else:
                res = fail(request_id, f"unknown cmd {cmd!r} (info, flow, shutdown)")
        except Exception as exc:  # never let one request kill the worker
            res = fail(request_id, f"{type(exc).__name__}: {exc}")
        stdout.write(json.dumps(res) + "\n")
        stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
