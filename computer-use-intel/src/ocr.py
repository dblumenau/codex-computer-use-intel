#!/usr/bin/env python3
"""Native macOS OCR helper for computer-use-intel (x86_64 Intel Macs).

Uses Apple's Vision framework (VNRecognizeTextRequest) via PyObjC -- the same
on-device OCR engine the system uses for Live Text. No network, no Swift
compiler required (the CommandLineTools swiftc on this machine has an SDK
mismatch, so we bridge through Python/PyObjC instead).

Usage:   ocr.py <image-path> [--lang de-DE,en-US] [--fast]
Output:  JSON on stdout:
  { "width": <px>, "height": <px>,
    "lines": [ { "text": "...", "confidence": 0.97,
                 "cx": 0.5, "cy": 0.42, "w": 0.1, "h": 0.02 } ] }

cx/cy are the box CENTER, normalized 0..1, with a TOP-LEFT origin so the caller
can map straight onto screen points. w/h are normalized box size.
"""

import json
import sys

import Quartz
import Vision
from Foundation import NSURL


def fail(msg: str, code: int):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def main():
    args = sys.argv[1:]
    if not args:
        fail("usage: ocr.py <image-path> [--lang de-DE,en-US] [--fast]", 2)

    path = args[0]
    langs = ["de-DE", "en-US"]
    fast = False
    i = 1
    while i < len(args):
        if args[i] == "--lang" and i + 1 < len(args):
            langs = [s.strip() for s in args[i + 1].split(",") if s.strip()]
            i += 2
        elif args[i] == "--fast":
            fast = True
            i += 1
        else:
            i += 1

    url = NSURL.fileURLWithPath_(path)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    if src is None or Quartz.CGImageSourceGetCount(src) == 0:
        fail(f"could not load image: {path}", 3)
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg is None:
        fail(f"could not decode image: {path}", 3)

    width = Quartz.CGImageGetWidth(cg)
    height = Quartz.CGImageGetHeight(cg)

    request = Vision.VNRecognizeTextRequest.alloc().init()
    # 1 = accurate, 0 = fast
    request.setRecognitionLevel_(0 if fast else 1)
    request.setUsesLanguageCorrection_(True)
    try:
        request.setRecognitionLanguages_(langs)
    except Exception:
        pass

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    ok, err = handler.performRequests_error_([request], None)
    if not ok:
        fail(f"ocr failed: {err}", 4)

    lines = []
    for obs in (request.results() or []):
        cands = obs.topCandidates_(1)
        if not cands:
            continue
        cand = cands[0]
        text = cand.string()
        conf = float(cand.confidence())
        bb = obs.boundingBox()  # normalized, origin bottom-left
        ox = bb.origin.x
        oy = bb.origin.y
        w = bb.size.width
        h = bb.size.height
        cx = ox + w / 2.0
        cy_bottom = oy + h / 2.0
        cy_top = 1.0 - cy_bottom  # flip to top-left origin
        lines.append(
            {
                "text": str(text),
                "confidence": round(conf, 4),
                "cx": round(float(cx), 6),
                "cy": round(float(cy_top), 6),
                "w": round(float(w), 6),
                "h": round(float(h), 6),
            }
        )

    sys.stdout.write(json.dumps({"width": int(width), "height": int(height), "lines": lines}))


if __name__ == "__main__":
    main()
