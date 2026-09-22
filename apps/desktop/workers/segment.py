"""YOLO11n-seg instance-segmentation worker (Phase S, tier 1).

A stdio NDJSON subprocess: the Electron main process spawns it, sends one
JSON request per line on stdin, and reads one JSON response per line on
stdout. Stderr is diagnostics only — stdout stays protocol-clean.

Protocol:
  -> {"id": 1, "cmd": "info"}
  <- {"id": 1, "ok": true, "model": "yolo11n-seg.pt", "device": "cuda:0",
      "classes": ["person", ...]}

  -> {"id": 2, "cmd": "segment", "image_b64": "<png/jpeg>",
      "classes": ["person"], "conf": 0.25, "imgsz": 640}
  <- {"id": 2, "ok": true, "width": W, "height": H, "device": "cuda:0", "ms": 12.5,
      "detections": [{"cls": "person", "cls_id": 0, "conf": 0.91,
                      "bbox": [x1, y1, x2, y2], "area": 12345,
                      "mask_b64": "<grayscale png, WxH, 255=foreground>"}]}

  -> {"id": 3, "cmd": "shutdown"}
  <- {"id": 3, "ok": true}   (then the process exits 0)

Errors: {"id": N, "ok": false, "error": "<message>"}.

Stdout is responses plus, on a fresh settings dir only, Ultralytics'
one-line settings notice — the driver skips any non-JSON line.

The model (yolo11n-seg.pt, ~6 MB) downloads on first use into the
Ultralytics settings dir; the spawner points YOLO_CONFIG_DIR at the app's
models folder so nothing lands in the user's global config. CUDA is used
when torch sees it, else CPU.

License note: Ultralytics is AGPL-3.0. It runs here as an arms-length
subprocess behind this documented JSON protocol — no Ultralytics code is
imported, linked, or vendored into Diffusion Studio itself.
"""

import base64
import io
import json
import os
import sys
import time

RESPONSE_SCHEMA_VERSION = 1

MODEL_FILE = "yolo11n-seg.pt"


def log(message):
    print(f"[segment-worker] {message}", file=sys.stderr, flush=True)


def fail(request_id, message):
    return {"id": request_id, "ok": False, "error": str(message)}


def models_dir():
    """Where weights live: the app points YOLO_CONFIG_DIR here. A bare
    filename would make Ultralytics download into the process cwd instead
    (not writable when packaged), so the model always loads by absolute path."""
    for var in ("YOLO_CONFIG_DIR", "ULTRALYTICS_SETTINGS_DIR"):
        home = os.environ.get(var)
        if home:
            return home
    return os.path.join(os.path.expanduser("~"), ".ultralytics")


class SegmentWorker:
    def __init__(self):
        self.model = None
        self.model_name = MODEL_FILE
        self.device = None

    def ensure_model(self):
        if self.model is not None:
            return
        import torch
        from ultralytics import YOLO

        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        weights = os.path.join(models_dir(), self.model_name)
        log(f"loading {weights} on {self.device}")
        started = time.perf_counter()
        # Missing weights download next to the path: into the models dir,
        # never the process cwd.
        self.model = YOLO(weights)
        log(f"model ready in {(time.perf_counter() - started) * 1000:.0f} ms")

    def info(self, request_id):
        self.ensure_model()
        names = self.model.names
        classes = [names[i] for i in sorted(names)]
        return {
            "id": request_id,
            "ok": True,
            "schema": RESPONSE_SCHEMA_VERSION,
            "model": self.model_name,
            "device": self.device,
            "classes": classes,
        }

    def segment(self, req):
        import cv2
        import numpy as np

        self.ensure_model()
        request_id = req.get("id")

        raw = req.get("image_b64")
        if not isinstance(raw, str) or not raw:
            return fail(request_id, "segment needs image_b64 (base64 png/jpeg)")
        try:
            blob = base64.b64decode(raw)
        except Exception as exc:
            return fail(request_id, f"image_b64 is not valid base64: {exc}")
        image = cv2.imdecode(np.frombuffer(blob, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return fail(request_id, "image_b64 did not decode to an image")
        orig_h, orig_w = image.shape[:2]

        wanted = req.get("classes")
        names = self.model.names
        if wanted is None:
            keep_ids = None
        else:
            if not isinstance(wanted, list) or not all(isinstance(c, str) for c in wanted):
                return fail(request_id, "classes must be a list of COCO class names")
            unknown = [c for c in wanted if c not in names.values()]
            if unknown:
                return fail(request_id, f"unknown classes: {', '.join(unknown)}")
            keep_ids = [i for i, n in names.items() if n in wanted]

        conf = req.get("conf", 0.25)
        if not isinstance(conf, (int, float)) or not 0 < conf < 1:
            return fail(request_id, f"conf must be in (0, 1), got {conf!r}")
        imgsz = req.get("imgsz", 640)
        if not isinstance(imgsz, int) or imgsz < 128 or imgsz > 2048:
            return fail(request_id, f"imgsz must be an int in 128..2048, got {imgsz!r}")

        started = time.perf_counter()
        results = self.model.predict(image, conf=conf, imgsz=imgsz, classes=keep_ids, verbose=False)
        ms = (time.perf_counter() - started) * 1000

        detections = []
        result = results[0]
        if result.masks is not None and result.boxes is not None:
            masks = result.masks.data.cpu().numpy()
            boxes = result.boxes.xyxy.cpu().numpy()
            cls_ids = result.boxes.cls.cpu().numpy().astype(int)
            confs = result.boxes.conf.cpu().numpy()
            for i in range(len(masks)):
                # Masks come back at the model's mask resolution; scale to
                # the source frame with nearest-neighbor so edges stay crisp.
                # (Verified against the plotted overlay in E2E.)
                m = masks[i]
                if (m.shape[1], m.shape[0]) != (orig_w, orig_h):
                    m = cv2.resize(m, (orig_w, orig_h), interpolation=cv2.INTER_NEAREST)
                binary = (m > 0.5).astype(np.uint8) * 255
                ok, png = cv2.imencode(".png", binary)
                if not ok:
                    return fail(request_id, "mask png encoding failed")
                x1, y1, x2, y2 = (float(v) for v in boxes[i])
                detections.append(
                    {
                        "cls": names[int(cls_ids[i])],
                        "cls_id": int(cls_ids[i]),
                        "conf": round(float(confs[i]), 4),
                        "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                        "area": int((binary > 0).sum()),
                        "mask_b64": base64.b64encode(png.tobytes()).decode("ascii"),
                    }
                )

        return {
            "id": request_id,
            "ok": True,
            "width": orig_w,
            "height": orig_h,
            "device": self.device,
            "ms": round(ms, 1),
            "detections": detections,
        }


def main():
    worker = SegmentWorker()
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
            elif cmd == "segment":
                res = worker.segment(req)
            elif cmd == "shutdown":
                res = {"id": request_id, "ok": True}
                stdout.write(json.dumps(res) + "\n")
                stdout.flush()
                return 0
            else:
                res = fail(request_id, f"unknown cmd {cmd!r} (info, segment, shutdown)")
        except Exception as exc:  # never let one request kill the worker
            res = fail(request_id, f"{type(exc).__name__}: {exc}")
        stdout.write(json.dumps(res) + "\n")
        stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
