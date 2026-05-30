// Native macOS OCR helper for computer-use-intel (x86_64 Intel Macs).
//
// Uses Apple's Vision framework (VNRecognizeTextRequest) -- the same on-device
// OCR engine the system uses for Live Text. No network, no third-party deps.
// Compiled with the full Xcode toolchain (the CommandLineTools swiftc had an
// SDK/compiler mismatch and was unusable).
//
// Usage:
//   vision-ocr <image-path> [--lang de-DE,en-US] [--fast] [--annotate out.png]
//   vision-ocr pixel <image-path>
//
// OCR output JSON on stdout:
//   { "width": <px>, "height": <px>, "annotated": "out.png"?,
//     "lines": [ { "text": "...", "confidence": 0.97,
//                  "cx": 0.5, "cy": 0.42, "w": 0.1, "h": 0.02 } ] }
//   cx/cy are the box CENTER, normalized 0..1, TOP-LEFT origin (maps straight
//   onto screen points). Matches the JSON contract of src/ocr.py.
//
// --annotate draws numbered boxes (Set-of-Marks) over each recognized line and
//   writes a PNG; the line index == the printed number.
//
// pixel output JSON: { "ok": true, "r": 0-255, "g": .., "b": .., "hex": "#RRGGBB" }
//   Reads the pixel of a (typically 1x1) capture for on-screen color sampling.

import Foundation
import Vision
import AppKit

struct Line: Codable {
    let text: String
    let confidence: Float
    let cx: Double
    let cy: Double
    let w: Double
    let h: Double
}

struct Output: Codable {
    let width: Int
    let height: Int
    let lines: [Line]
}

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: vision-ocr <image-path> [--lang ..] [--fast] [--annotate out.png] | vision-ocr pixel <image>", 2)
}

func loadCGImage(_ p: String) -> CGImage {
    guard let img = NSImage(contentsOfFile: p),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fail("could not load image: \(p)", 3)
    }
    return cg
}

// Subcommand: pixel color sampling.
if args[1] == "pixel" {
    guard args.count >= 3 else { fail("usage: vision-ocr pixel <image>", 2) }
    let cg = loadCGImage(args[2])
    var px = [UInt8](repeating: 0, count: 4)
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8,
                              bytesPerRow: 4, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fail("could not create pixel context", 6)
    }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    let r = Int(px[0]); let g = Int(px[1]); let b = Int(px[2])
    let hex = String(format: "#%02X%02X%02X", r, g, b)
    let out: [String: Any] = ["ok": true, "r": r, "g": g, "b": b, "hex": hex]
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
    exit(0)
}

let path = args[1]
var langs: [String] = ["de-DE", "en-US"]
var fast = false
var annotatePath: String? = nil

var i = 2
while i < args.count {
    switch args[i] {
    case "--lang":
        if i + 1 < args.count {
            langs = args[i + 1].split(separator: ",").map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            i += 2
        } else { i += 1 }
    case "--fast":
        fast = true
        i += 1
    case "--annotate":
        if i + 1 < args.count { annotatePath = args[i + 1]; i += 2 } else { i += 1 }
    default:
        i += 1
    }
}

let cg = loadCGImage(path)

let request = VNRecognizeTextRequest()
request.recognitionLevel = fast ? .fast : .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = langs

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("ocr failed: \(error)", 4)
}

var lines: [Line] = []
for obs in (request.results ?? []) {
    guard let cand = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox // normalized, origin bottom-left
    lines.append(Line(
        text: cand.string,
        confidence: cand.confidence,
        cx: Double(bb.midX),
        cy: Double(1.0 - bb.midY), // flip to top-left origin
        w: Double(bb.width),
        h: Double(bb.height)
    ))
}

// Optional Set-of-Marks annotation: draw numbered boxes over each line.
func drawAnnotated(_ cg: CGImage, _ lines: [Line], _ outPath: String) -> Bool {
    let w = cg.width
    let h = cg.height
    let base = NSImage(cgImage: cg, size: NSSize(width: w, height: h))
    let out = NSImage(size: NSSize(width: w, height: h))
    out.lockFocus()
    base.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
    for (idx, ln) in lines.enumerated() {
        let bw = ln.w * Double(w)
        let bh = ln.h * Double(h)
        let xp = ln.cx * Double(w) - bw / 2.0
        let yTop = ln.cy * Double(h) - bh / 2.0
        let yp = Double(h) - (yTop + bh) // flip to bottom-left origin for AppKit
        let rect = NSRect(x: xp, y: yp, width: bw, height: bh)
        NSColor.systemRed.setStroke()
        let pathRect = NSBezierPath(rect: rect)
        pathRect.lineWidth = 2.0
        pathRect.stroke()
        let fontSize = max(11.0, min(bh * 0.7, 28.0))
        let label = "\(idx)" as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.white,
            .backgroundColor: NSColor.systemRed,
            .font: NSFont.boldSystemFont(ofSize: fontSize),
        ]
        label.draw(at: NSPoint(x: xp, y: yp + bh - fontSize), withAttributes: attrs)
    }
    out.unlockFocus()
    guard let tiff = out.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return false }
    do { try png.write(to: URL(fileURLWithPath: outPath)); return true } catch { return false }
}

var annotatedResult: String? = nil
if let ap = annotatePath {
    if drawAnnotated(cg, lines, ap) { annotatedResult = ap }
}

// Encode OCR result, injecting "annotated" when present.
let encoder = JSONEncoder()
let baseData = try! encoder.encode(Output(width: cg.width, height: cg.height, lines: lines))
if let ap = annotatedResult,
   var dict = try? JSONSerialization.jsonObject(with: baseData) as? [String: Any] {
    dict["annotated"] = ap
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: dict))
} else {
    FileHandle.standardOutput.write(baseData)
}
