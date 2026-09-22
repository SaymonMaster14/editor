"""Depth-Anything-V2-Small monocular depth worker (Phase T, tier 1).

A stdio NDJSON subprocess: the Electron main process spawns it, sends one
JSON request per line on stdin, and reads one JSON response per line on
stdout. Stderr is diagnostics only — stdout stays protocol-clean.

Protocol:
  -> {"id": 1, "cmd": "info"}
  <- {"id": 1, "ok": true, "model": "depth-anything/Depth-Anything-V2-Small-hf",
      "device": "cuda:0"}

  -> {"id": 2, "cmd": "depth", "image_b64": "<png/jpeg>"}
  <- {"id": 2, "ok": true, "width": W, "height": H, "device": "cuda:0",
      "ms": 540.0, "dmin": 0.13, "dmax": 8.25,
      "depth_b64": "<16-bit grayscale png, WxH>"}

  -> {"id": 3, "cmd": "shutdown"}
  <- {"id": 3, "ok": true}   (then the process exits 0)

Errors: {"id": N, "ok": false, "error": "<message>"}.

The depth map is relative inverse depth (larger = closer), normalized
per frame: pixel/65535 maps linearly onto [dmin, dmax]. Compare depths
within one frame, never across frames. Values are fp32 model output;
the 16-bit PNG keeps full precision for compositing (fog, DoF, parallax).

Weights (~100 MB, Apache-2.0) download on first use into the HuggingFace
cache, which the spawner points at the app's models dir (HF_HOME), so
nothing lands in the user's global cache.

Stdout is responses only — transformers/hub chatter goes to stderr.
"""

import base64
import json
import sys
import time

RESPONSE_SCHEMA_VERSION = 1


def log(message):
    print(f"[depth-worker] {message}", file=sys.stderr, flush=True)


def fail(request_id, message):
    return {"id": request_id, "ok": False, "error": str(message)}


class DepthWorker:
    def __init__(self):
        self.model = None
        self.processor = None
        self.model_id = "depth-anything/Depth-Anything-V2-Small-hf"
        self.device = None

    def ensure_model(self):
        if self.model is not None:
            return
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        log(f"loading {self.model_id} on {self.device}")
        started = time.perf_counter()
        # Weights resolve through HF_HOME, which the spawner points at the
        # app's models dir; first run downloads there (~100 MB).
        self.processor = AutoImageProcessor.from_pretrained(self.model_id)
        self.model = AutoModelForDepthEstimation.from_pretrained(self.model_id).to(self.device).eval()
        log(f"model ready in {(time.perf_counter() - started) * 1000:.0f} ms")

    def info(self, request_id):
        self.ensure_model()
        return {
            "id": request_id,
            "ok": True,
            "schema": RESPONSE_SCHEMA_VERSION,
            "model": self.model_id,
            "device": self.device,
        }

    def depth(self, req):
        import cv2
        import numpy as np
        import torch

        self.ensure_model()
        request_id = req.get("id")

        raw = req.get("image_b64")
        if not isinstance(raw, str) or not raw:
            return fail(request_id, "depth needs image_b64 (base64 png/jpeg)")
        try:
            blob = base64.b64decode(raw)
        except Exception as exc:
            return fail(request_id, f"image_b64 is not valid base64: {exc}")
        try:
            image = cv2.imdecode(np.frombuffer(blob, np.uint8), cv2.IMREAD_COLOR)
        except Exception:
            image = None
        if image is None:
            return fail(request_id, "image_b64 did not decode to an image")
        orig_h, orig_w = image.shape[:2]

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        inputs = self.processor(images=rgb, return_tensors="pt").to(self.device)
        started = time.perf_counter()
        with torch.inference_mode():
            predicted = self.model(**inputs).predicted_depth
            if self.device.startswith("cuda"):
                torch.cuda.synchronize()
        ms = (time.perf_counter() - started) * 1000

        upsampled = torch.nn.functional.interpolate(
            predicted.unsqueeze(1), size=(orig_h, orig_w), mode="bicubic", align_corners=False
        )
        d = upsampled.squeeze().cpu().numpy().astype(np.float64)
        dmin, dmax = float(d.min()), float(d.max())
        span = dmax - dmin if dmax > dmin else 1.0
        quantized = (((d - dmin) / span) * 65535.0).round().astype(np.uint16)
        ok, png = cv2.imencode(".png", quantized)
        if not ok:
            return fail(request_id, "depth png encoding failed")

        return {
            "id": request_id,
            "ok": True,
            "width": orig_w,
            "height": orig_h,
            "device": self.device,
            "ms": round(ms, 1),
            "dmin": dmin,
            "dmax": dmax,
            "depth_b64": base64.b64encode(png.tobytes()).decode("ascii"),
        }


def main():
    worker = DepthWorker()
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
            elif cmd == "depth":
                res = worker.depth(req)
            elif cmd == "shutdown":
                res = {"id": request_id, "ok": True}
                stdout.write(json.dumps(res) + "\n")
                stdout.flush()
                return 0
            else:
                res = fail(request_id, f"unknown cmd {cmd!r} (info, depth, shutdown)")
        except Exception as exc:  # never let one request kill the worker
            res = fail(request_id, f"{type(exc).__name__}: {exc}")
        stdout.write(json.dumps(res) + "\n")
        stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
