// Accessibility (AX) helper for computer-use-intel (x86_64 Intel Macs).
//
// Gives the MCP server structured access to the macOS Accessibility tree so the
// agent can interact with real UI elements (buttons, fields, menu items, windows)
// instead of guessing pixel coordinates from screenshots. Requires the host
// process (Codex) to have Accessibility permission.
//
// All coordinates are screen points, top-left origin (same space as cliclick).
//
// Subcommands (JSON on stdout):
//   ax-helper dump        [--app NAME|--pid N] [--actionable-only] [--max-nodes N]
//   ax-helper find        [matchers] [--app ...] [--max-nodes N]
//   ax-helper click       [matchers] [--app ...]                 (AXPress)
//   ax-helper setvalue    --value V [matchers] [--app ...]
//   ax-helper getvalue    [matchers] [--app ...]
//   ax-helper menu        --path "File>Save" [--app NAME]
//   ax-helper windows     [--app NAME]
//   ax-helper window      --action focus|move|resize|minimize|unminimize
//                         [--app NAME] [--title T] [--index I] [--x N --y N] [--width N --height N]
//   ax-helper selected-text
//   ax-helper app-info [--app NAME|BUNDLE_ID] | focus-app --app NAME|BUNDLE_ID
//
// Matchers (any combination): --role ROLE --title T --value V --index I
//   --title/--value/--role match case-insensitive substring; --index picks the
//   Nth match (0-based) after filtering.

import Foundation
import AppKit
import ApplicationServices

// MARK: - JSON output

func emit(_ obj: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
    FileHandle.standardOutput.write(data)
    exit(0)
}

func emitError(_ msg: String) -> Never {
    emit(["ok": false, "error": msg])
}

// MARK: - Arg parsing

var args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else { emitError("usage: ax-helper <dump|find|click|setvalue|getvalue|menu|windows|window|selected-text> [...]") }
args.removeFirst()

func opt(_ name: String) -> String? {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return nil
}
func flag(_ name: String) -> Bool { args.contains(name) }

let optApp = opt("--app")
let optPid = opt("--pid").flatMap { Int32($0) }
let optRole = opt("--role")
let optTitle = opt("--title")
let optValue = opt("--value")
let optIndex = opt("--index").flatMap { Int($0) }
let actionableOnly = flag("--actionable-only")
let maxNodes = opt("--max-nodes").flatMap { Int($0) } ?? 1500

// MARK: - AX attribute helpers

func attr(_ el: AXUIElement, _ key: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(el, key as CFString, &value)
    return err == .success ? value : nil
}

func strAttr(_ el: AXUIElement, _ key: String) -> String? {
    guard let v = attr(el, key) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func point(_ el: AXUIElement) -> CGPoint? {
    guard let v = attr(el, kAXPositionAttribute as String) else { return nil }
    var p = CGPoint.zero
    if AXValueGetValue(v as! AXValue, .cgPoint, &p) { return p }
    return nil
}

func size(_ el: AXUIElement) -> CGSize? {
    guard let v = attr(el, kAXSizeAttribute as String) else { return nil }
    var s = CGSize.zero
    if AXValueGetValue(v as! AXValue, .cgSize, &s) { return s }
    return nil
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    guard let v = attr(el, kAXChildrenAttribute as String) as? [AXUIElement] else { return [] }
    return v
}

func actionNames(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyActionNames(el, &names)
    if err == .success, let arr = names as? [String] { return arr }
    return []
}

let actionableRoles: Set<String> = [
    "AXButton", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXTextField", "AXTextArea", "AXLink", "AXTab", "AXSlider",
    "AXComboBox", "AXSearchField", "AXDisclosureTriangle", "AXSegmentedControl",
    "AXIncrementor", "AXStepper", "AXCell", "AXRow",
]

struct Node {
    let el: AXUIElement
    let role: String
    let title: String
    let value: String
    let x: Int
    let y: Int
    let w: Int
    let h: Int
    let enabled: Bool
    let actionable: Bool
}

func describe(_ el: AXUIElement) -> Node {
    let role = strAttr(el, kAXRoleAttribute as String) ?? ""
    var title = strAttr(el, kAXTitleAttribute as String) ?? ""
    if title.isEmpty { title = strAttr(el, kAXDescriptionAttribute as String) ?? "" }
    if title.isEmpty { title = strAttr(el, "AXLabel") ?? "" }
    let value = strAttr(el, kAXValueAttribute as String) ?? ""
    let p = point(el) ?? .zero
    let s = size(el) ?? .zero
    let enabled = (attr(el, kAXEnabledAttribute as String) as? NSNumber)?.boolValue ?? true
    let acts = actionNames(el)
    let actionable = actionableRoles.contains(role) || acts.contains(kAXPressAction as String)
    return Node(el: el, role: role, title: title, value: value,
                x: Int(p.x), y: Int(p.y), w: Int(s.width), h: Int(s.height),
                enabled: enabled, actionable: actionable)
}

// MARK: - App resolution

func resolvePid() -> pid_t? {
    if let p = optPid { return p }
    if let name = optApp {
        let lc = name.lowercased()
        for app in NSWorkspace.shared.runningApplications {
            if let n = app.localizedName, n.lowercased() == lc { return app.processIdentifier }
            if app.bundleIdentifier?.lowercased() == lc { return app.processIdentifier }
        }
        return nil
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

// NSWorkspace-based identity/focus does not need an AX tree and resolves bundle IDs exactly.
if mode == "app-info" || mode == "focus-app" {
    guard let pid = resolvePid(), let app = NSRunningApplication(processIdentifier: pid) else {
        emitError("running app not found")
    }
    if mode == "focus-app" {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
            // The return value can be false for an already active application;
            // the observed foreground PID below is the authoritative result.
            app.activate(options: [.activateAllWindows])
        }
        let deadline = Date().addingTimeInterval(2)
        while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            emitError("app did not become frontmost within 2 seconds")
        }
    }
    emit(["ok": true, "pid": Int(pid), "name": app.localizedName ?? "",
          "bundleId": app.bundleIdentifier ?? ""])
}

// MARK: - Tree walk

func walk(_ root: AXUIElement, collect: inout [Node]) {
    var queue = [root]
    var seen = 0
    while !queue.isEmpty && collect.count < maxNodes {
        let el = queue.removeFirst()
        seen += 1
        if seen > maxNodes * 4 { break }
        let n = describe(el)
        let hasGeom = n.w > 0 && n.h > 0
        if hasGeom && (!actionableOnly || n.actionable) {
            collect.append(n)
        }
        queue.append(contentsOf: children(el))
    }
}

func nodeJSON(_ n: Node, index: Int) -> [String: Any] {
    return [
        "index": index,
        "role": n.role,
        "title": n.title,
        "value": n.value.count > 200 ? String(n.value.prefix(200)) : n.value,
        "enabled": n.enabled,
        "actionable": n.actionable,
        "x": n.x + n.w / 2, // center, clickable
        "y": n.y + n.h / 2,
        "frame": ["x": n.x, "y": n.y, "w": n.w, "h": n.h],
    ]
}

func matches(_ n: Node) -> Bool {
    if let r = optRole, !n.role.lowercased().contains(r.lowercased()) { return false }
    if let t = optTitle, !n.title.lowercased().contains(t.lowercased()) { return false }
    if let v = optValue, !n.value.lowercased().contains(v.lowercased()) { return false }
    return true
}

func appRootOrFail() -> AXUIElement {
    guard let pid = resolvePid() else { emitError("app not found / no frontmost app") }
    // Surface a clear permission error.
    if !AXIsProcessTrusted() {
        emitError("accessibility permission not granted to host process")
    }
    return AXUIElementCreateApplication(pid)
}

// MARK: - Commands

switch mode {
case "dump", "find":
    let root = appRootOrFail()
    var nodes: [Node] = []
    walk(root, collect: &nodes)
    if mode == "find" { nodes = nodes.filter(matches) }
    var out: [[String: Any]] = []
    for (i, n) in nodes.enumerated() { out.append(nodeJSON(n, index: i)) }
    emit(["ok": true, "count": out.count, "elements": out])

case "click", "setvalue", "getvalue":
    let root = appRootOrFail()
    var nodes: [Node] = []
    walk(root, collect: &nodes)
    let filtered = nodes.filter(matches)
    if filtered.isEmpty { emitError("no element matched") }
    let pick = optIndex ?? 0
    if pick >= filtered.count { emitError("index \(pick) out of range (\(filtered.count) matches)") }
    let target = filtered[pick]
    if mode == "getvalue" {
        emit(["ok": true, "role": target.role, "title": target.title, "value": target.value])
    } else if mode == "setvalue" {
        guard let v = optValue ?? opt("--set") else { emitError("setvalue requires --value") }
        let err = AXUIElementSetAttributeValue(target.el, kAXValueAttribute as CFString, v as CFString)
        if err == .success { emit(["ok": true, "set": v, "role": target.role, "title": target.title]) }
        else { emitError("AXSetValue failed (err \(err.rawValue))") }
    } else {
        let err = AXUIElementPerformAction(target.el, kAXPressAction as CFString)
        if err == .success {
            emit(["ok": true, "pressed": ["role": target.role, "title": target.title,
                                          "x": target.x + target.w / 2, "y": target.y + target.h / 2]])
        } else {
            // Fall back to reporting center coords so the caller can cliclick it.
            emit(["ok": true, "pressFailed": true,
                  "center": ["x": target.x + target.w / 2, "y": target.y + target.h / 2],
                  "role": target.role, "title": target.title])
        }
    }

case "menu":
    guard let path = opt("--path") else { emitError("menu requires --path \"File>Save\"") }
    let root = appRootOrFail()
    guard let bar = attr(root, kAXMenuBarAttribute as String) else { emitError("no menu bar") }
    var current = bar as! AXUIElement
    let parts = path.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }
    var pressedTitles: [String] = []
    for (depth, part) in parts.enumerated() {
        // Search direct children (and the AXMenu wrapper) for a title match.
        var pool = children(current)
        // Menu items wrap their submenu in an AXMenu child; flatten one level.
        pool += pool.flatMap { children($0) }
        guard let hit = pool.first(where: {
            (strAttr($0, kAXTitleAttribute as String) ?? "").lowercased() == part.lowercased()
        }) else {
            emitError("menu path segment not found: \"\(part)\" (after \(pressedTitles))")
        }
        pressedTitles.append(part)
        if depth == parts.count - 1 {
            let err = AXUIElementPerformAction(hit, kAXPressAction as CFString)
            if err == .success { emit(["ok": true, "clicked": path]) }
            else { emitError("AXPress on \"\(part)\" failed (err \(err.rawValue))") }
        } else {
            // Open the submenu so its children populate.
            AXUIElementPerformAction(hit, kAXPressAction as CFString)
            usleep(120_000)
            if let sub = children(hit).first(where: { (strAttr($0, kAXRoleAttribute as String) ?? "") == "AXMenu" }) {
                current = sub
            } else {
                current = hit
            }
        }
    }
    emitError("menu navigation incomplete")

case "windows":
    let root = appRootOrFail()
    guard let wins = attr(root, kAXWindowsAttribute as String) as? [AXUIElement] else {
        emit(["ok": true, "count": 0, "windows": []])
    }
    var out: [[String: Any]] = []
    for (i, w) in wins.enumerated() {
        let p = point(w) ?? .zero
        let s = size(w) ?? .zero
        let minimized = (attr(w, kAXMinimizedAttribute as String) as? NSNumber)?.boolValue ?? false
        out.append([
            "index": i,
            "title": strAttr(w, kAXTitleAttribute as String) ?? "",
            "minimized": minimized,
            "frame": ["x": Int(p.x), "y": Int(p.y), "w": Int(s.width), "h": Int(s.height)],
        ])
    }
    emit(["ok": true, "count": out.count, "windows": out])

case "window":
    guard let action = opt("--action") else { emitError("window requires --action") }
    let root = appRootOrFail()
    guard let wins = attr(root, kAXWindowsAttribute as String) as? [AXUIElement], !wins.isEmpty else {
        emitError("app has no windows")
    }
    var target: AXUIElement?
    if let t = optTitle {
        target = wins.first { (strAttr($0, kAXTitleAttribute as String) ?? "").lowercased().contains(t.lowercased()) }
    } else {
        target = wins[min(optIndex ?? 0, wins.count - 1)]
    }
    guard let win = target else { emitError("window not found") }
    switch action {
    case "focus":
        AXUIElementPerformAction(win, kAXRaiseAction as CFString)
        if let pid = resolvePid(), let app = NSRunningApplication(processIdentifier: pid) {
            app.activate(options: [.activateAllWindows])
        }
        emit(["ok": true, "action": "focus"])
    case "minimize", "unminimize":
        let v: CFBoolean = (action == "minimize") ? kCFBooleanTrue : kCFBooleanFalse
        let err = AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, v)
        if err == .success { emit(["ok": true, "action": action]) } else { emitError("set minimized failed") }
    case "move":
        guard let xs = opt("--x"), let ys = opt("--y"), let x = Double(xs), let y = Double(ys) else { emitError("move requires --x --y") }
        var p = CGPoint(x: x, y: y)
        let v = AXValueCreate(.cgPoint, &p)!
        let err = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, v)
        if err == .success { emit(["ok": true, "action": "move", "x": x, "y": y]) } else { emitError("move failed") }
    case "resize":
        guard let ws = opt("--width"), let hs = opt("--height"), let w = Double(ws), let h = Double(hs) else { emitError("resize requires --width --height") }
        var s = CGSize(width: w, height: h)
        let v = AXValueCreate(.cgSize, &s)!
        let err = AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, v)
        if err == .success { emit(["ok": true, "action": "resize", "width": w, "height": h]) } else { emitError("resize failed") }
    default:
        emitError("unknown window action: \(action)")
    }

case "selected-text":
    if !AXIsProcessTrusted() { emitError("accessibility permission not granted to host process") }
    let sys = AXUIElementCreateSystemWide()
    guard let focused = attr(sys, kAXFocusedUIElementAttribute as String) else {
        emit(["ok": true, "text": ""])
    }
    let el = focused as! AXUIElement
    let sel = strAttr(el, kAXSelectedTextAttribute as String) ?? ""
    emit(["ok": true, "text": sel])

default:
    emitError("unknown mode: \(mode)")
}
