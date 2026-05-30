// CGEvent input helper for computer-use-intel (x86_64 Intel Macs).
//
// Posts real CoreGraphics HID events for precise scrolling and arbitrary key
// hold/tap — things cliclick (modifier-only key hold) and AppleScript
// (coarse "scroll by 1") cannot do well. Requires Accessibility permission on
// the host process (already needed for cliclick).
//
// Subcommands (JSON on stdout):
//   cgevent scroll --dy N [--dx N] [--x X --y Y] [--unit pixel|line]
//                  [--steps N] [--delay-ms M]
//       Posts scroll-wheel events. dy>0 scrolls UP, dy<0 scrolls DOWN;
//       dx>0 scrolls LEFT, dx<0 scrolls RIGHT. With --x/--y the pointer is
//       warped there first so the right view receives the events. --steps
//       splits the delta into N smaller events for smooth scrolling.
//
//   cgevent keydown --key NAME|CODE [--mods cmd,shift,ctrl,alt,fn]
//   cgevent keyup   --key NAME|CODE [--mods ...]
//       Press / release a SINGLE arbitrary key (held across processes — a
//       keydown stays logically down until a matching keyup is posted).
//
//   cgevent tap --key NAME|CODE [--mods ...] [--repeat N] [--delay-ms M]
//       Press+release a key (optionally several times). Works in apps where
//       AppleScript keystroke is ignored (e.g. games, terminals).

import Foundation
import CoreGraphics
import AppKit

func emit(_ obj: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
    FileHandle.standardOutput.write(data)
    exit(0)
}
func fail(_ msg: String) -> Never { emit(["ok": false, "error": msg]) }

var args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else { fail("usage: cgevent <scroll|keydown|keyup|tap> [...]") }
args.removeFirst()

func opt(_ name: String) -> String? {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return nil
}
func intOpt(_ name: String) -> Int? { opt(name).flatMap { Int($0) } }

let source = CGEventSource(stateID: .hidSystemState)

// MARK: - Modifier flags

func parseMods(_ s: String?) -> CGEventFlags {
    var flags: CGEventFlags = []
    guard let s = s else { return flags }
    for m in s.split(separator: ",") {
        switch m.trimmingCharacters(in: .whitespaces).lowercased() {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "opt", "option": flags.insert(.maskAlternate)
        case "fn", "function": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

// MARK: - Key name -> virtual keycode

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "equal": 24,
    "9": 25, "7": 26, "-": 27, "minus": 27, "8": 28, "0": 29,
    "]": 30, "rightbracket": 30, "o": 31, "u": 32, "[": 33, "leftbracket": 33,
    "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38,
    "'": 39, "quote": 39, "k": 40, ";": 41, "semicolon": 41, "\\": 42, "backslash": 42,
    ",": 43, "comma": 43, "/": 44, "slash": 44, "n": 45, "m": 46, ".": 47, "period": 47,
    "grave": 50, "`": 50, "tab": 48, "space": 49, " ": 49,
    "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "command": 55, "cmd": 55, "shift": 56, "capslock": 57, "option": 58, "alt": 58,
    "control": 59, "ctrl": 59, "rightshift": 60, "rightoption": 61, "rightcontrol": 62,
    "function": 63, "fn": 63,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "home": 115, "pageup": 116, "page-up": 116, "forwarddelete": 117, "forward-delete": 117,
    "end": 119, "pagedown": 121, "page-down": 121,
    "left": 123, "arrow-left": 123, "right": 124, "arrow-right": 124,
    "down": 125, "arrow-down": 125, "up": 126, "arrow-up": 126, "help": 114,
]

func resolveKey(_ s: String) -> CGKeyCode? {
    if let c = keyCodes[s.lowercased()] { return c }
    if let n = Int(s), n >= 0, n < 128 { return CGKeyCode(n) }
    return nil
}

func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let ev = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
    if !flags.isEmpty { ev.flags = flags }
    ev.post(tap: .cghidEventTap)
}

// MARK: - Commands

switch mode {
case "scroll":
    let dy = intOpt("--dy") ?? 0
    let dx = intOpt("--dx") ?? 0
    if dy == 0 && dx == 0 { fail("scroll needs --dy and/or --dx") }
    let unit: CGScrollEventUnit = (opt("--unit") == "pixel") ? .pixel : .line
    let steps = max(1, intOpt("--steps") ?? 1)
    let delayMs = intOpt("--delay-ms") ?? 8
    if let xs = opt("--x"), let ys = opt("--y"), let x = Double(xs), let y = Double(ys) {
        CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
        CGAssociateMouseAndMouseCursorPosition(1)
        usleep(15_000)
    }
    // Split into steps and distribute any remainder onto the last event.
    func chunk(_ total: Int, _ i: Int) -> Int32 {
        let base = total / steps
        let rem = total - base * steps
        return Int32(i == steps - 1 ? base + rem : base)
    }
    for i in 0..<steps {
        let w1 = chunk(dy, i)
        let w2 = chunk(dx, i)
        if let ev = CGEvent(scrollWheelEvent2Source: source, units: unit,
                            wheelCount: 2, wheel1: w1, wheel2: w2, wheel3: 0) {
            ev.post(tap: .cghidEventTap)
        }
        if i < steps - 1 { usleep(useconds_t(delayMs * 1000)) }
    }
    emit(["ok": true, "dy": dy, "dx": dx, "unit": unit == .pixel ? "pixel" : "line", "steps": steps])

case "keydown", "keyup":
    guard let ks = opt("--key"), let code = resolveKey(ks) else { fail("keydown/keyup need a valid --key") }
    postKey(code, down: mode == "keydown", flags: parseMods(opt("--mods")))
    emit(["ok": true, "key": ks, "code": Int(code), "down": mode == "keydown"])

case "tap":
    guard let ks = opt("--key"), let code = resolveKey(ks) else { fail("tap needs a valid --key") }
    let flags = parseMods(opt("--mods"))
    let repeats = max(1, intOpt("--repeat") ?? 1)
    let delayMs = intOpt("--delay-ms") ?? 20
    for i in 0..<repeats {
        postKey(code, down: true, flags: flags)
        usleep(useconds_t(max(1, delayMs) * 1000 / 2))
        postKey(code, down: false, flags: flags)
        if i < repeats - 1 { usleep(useconds_t(max(1, delayMs) * 1000)) }
    }
    emit(["ok": true, "key": ks, "code": Int(code), "repeat": repeats])

default:
    fail("unknown mode: \(mode)")
}
