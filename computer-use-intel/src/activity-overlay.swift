import AppKit
import QuartzCore

final class RainbowView: NSView {
    var pointer: NSPoint? = nil
    private let rim = CAGradientLayer()
    override var isOpaque: Bool { false }
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(rim)
        configureRim()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    private func configureRim() {
        rim.frame = bounds
        rim.type = .conic
        rim.startPoint = CGPoint(x: 0.5, y: 0.5)
        rim.endPoint = CGPoint(x: 0.5, y: 1)
        let palette: [NSColor] = [
            NSColor(calibratedRed: 1, green: 0.22, blue: 0.65, alpha: 1),
            NSColor(calibratedRed: 1, green: 0.35, blue: 0.36, alpha: 1),
            NSColor(calibratedRed: 1, green: 0.85, blue: 0.48, alpha: 1),
            NSColor(calibratedRed: 0.45, green: 0.95, blue: 0.8, alpha: 1),
            NSColor(calibratedRed: 0.25, green: 0.8, blue: 1, alpha: 1),
            NSColor(calibratedRed: 0.34, green: 0.45, blue: 1, alpha: 1),
            NSColor(calibratedRed: 0.7, green: 0.4, blue: 1, alpha: 1),
            NSColor(calibratedRed: 1, green: 0.35, blue: 0.85, alpha: 1),
        ]
        let colors = palette.map { $0.cgColor }
        rim.colors = colors + [colors[0]]
        // A feathered alpha mask gives each moving color its own inward glow.
        let width = Int(bounds.width), height = Int(bounds.height)
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let path = CGPath(roundedRect: bounds.insetBy(dx: 4, dy: 4), cornerWidth: 24, cornerHeight: 24, transform: nil)
        for strokeWidth in stride(from: 64, through: 8, by: -2) {
            let distance = CGFloat(strokeWidth - 8) / 2
            let alpha = 0.065 * exp(-distance * distance / (2 * 12 * 12))
            context.addPath(path)
            context.setStrokeColor(NSColor.white.withAlphaComponent(alpha).cgColor)
            context.setLineWidth(CGFloat(strokeWidth))
            context.strokePath()
        }
        context.addPath(path)
        context.setStrokeColor(NSColor.white.cgColor)
        context.setLineWidth(7)
        context.strokePath()
        let mask = CALayer()
        mask.frame = bounds
        mask.contents = context.makeImage()
        rim.mask = mask
        let flow = CAKeyframeAnimation(keyPath: "colors")
        flow.values = (0...colors.count).map { step -> [CGColor] in
            let rotated = (0..<colors.count).map { colors[($0 + step) % colors.count] }
            return rotated + [rotated[0]]
        }
        flow.duration = 16
        flow.repeatCount = .infinity
        flow.calculationMode = .linear
        rim.add(flow, forKey: "colorFlow")
        let breathe = CABasicAnimation(keyPath: "opacity")
        breathe.fromValue = 0.82
        breathe.toValue = 1
        breathe.duration = 2.4
        breathe.autoreverses = true
        breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        rim.add(breathe, forKey: "breathe")
    }
    // Sparkles shed along the pointer's path: each drifts, twinkles and fades.
    struct Sparkle {
        let origin: NSPoint
        let drift: CGVector
        let born: TimeInterval
        let life: TimeInterval
        let hue: CGFloat
        let size: CGFloat
        let spin: CGFloat
        func position(at time: TimeInterval) -> NSPoint {
            let age = CGFloat(time - born)
            return NSPoint(x: origin.x + drift.dx * age, y: origin.y + drift.dy * age - 5 * age * age)
        }
    }
    var sparkles: [Sparkle] = []
    var lastSample: TimeInterval = 0
    private var trailHue: CGFloat = 0
    func shed(from a: NSPoint, to b: NSPoint, at time: TimeInterval) {
        let distance = hypot(b.x - a.x, b.y - a.y)
        let count = min(48, max(1, Int(distance / 7)))
        for i in 0..<count {
            let t = (CGFloat(i) + .random(in: 0...1)) / CGFloat(count)
            sparkles.append(Sparkle(
                origin: NSPoint(x: a.x + (b.x - a.x) * t + .random(in: -5...5), y: a.y + (b.y - a.y) * t + .random(in: -5...5)),
                drift: CGVector(dx: .random(in: -7...7), dy: .random(in: -3...9)),
                born: time, life: .random(in: 3.6...5.0),
                hue: (trailHue + distance * t / 520).truncatingRemainder(dividingBy: 1),
                size: .random(in: 3.5...8), spin: .random(in: 0...(2 * .pi))))
        }
        trailHue = (trailHue + distance / 520).truncatingRemainder(dividingBy: 1)
        if sparkles.count > 1200 { sparkles.removeFirst(sparkles.count - 1200) }
    }
    func tickSparkles(at time: TimeInterval) {
        for s in sparkles {
            let p = s.position(at: time)
            setNeedsDisplay(NSRect(x: p.x - 16, y: p.y - 16, width: 32, height: 32))
        }
        sparkles.removeAll { time - $0.born >= $0.life }
    }
    private func drawSparkles(at time: TimeInterval) {
        for s in sparkles {
            let progress = CGFloat((time - s.born) / s.life)
            guard progress < 1 else { continue }
            let p = s.position(at: time)
            let twinkle = 0.65 + 0.35 * sin(CGFloat(time) * 18 + s.spin * 3)
            let alpha = pow(1 - progress, 1.4) * twinkle
            let radius = s.size * (1 - 0.5 * progress)
            let color = NSColor(calibratedHue: s.hue, saturation: 0.75, brightness: 1, alpha: 1)
            color.withAlphaComponent(alpha * 0.22).setFill()
            NSBezierPath(ovalIn: NSRect(x: p.x - radius * 1.5, y: p.y - radius * 1.5, width: radius * 3, height: radius * 3)).fill()
            let star = NSBezierPath()
            let angle = s.spin + CGFloat(time - s.born) * 1.8
            for k in 0..<8 {
                let r = k % 2 == 0 ? radius : radius * 0.26
                let a = angle + CGFloat(k) * .pi / 4
                let v = NSPoint(x: p.x + cos(a) * r, y: p.y + sin(a) * r)
                if k == 0 { star.move(to: v) } else { star.line(to: v) }
            }
            star.close()
            color.blended(withFraction: 0.45, of: .white)!.withAlphaComponent(alpha).setFill()
            star.fill()
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        drawSparkles(at: Date.timeIntervalSinceReferenceDate)
        if let p = pointer {
            let time = Date.timeIntervalSinceReferenceDate
            let phase = time * 0.055
            let radius = 19 + 0.7 * sin(time * 2.2)
            for i in 0..<72 {
                let a = CGFloat(i) * 2 * .pi / 72
                let b = CGFloat(i + 1) * 2 * .pi / 72
                let segment = NSBezierPath()
                segment.move(to: NSPoint(x: p.x + cos(a) * radius, y: p.y + sin(a) * radius))
                segment.line(to: NSPoint(x: p.x + cos(b) * radius, y: p.y + sin(b) * radius))
                let hue = (CGFloat(i) / 72 + phase).truncatingRemainder(dividingBy: 1)
                let sparkle = pow(max(0, cos(a - time * 1.6)), 8)
                let color = NSColor(calibratedHue: hue, saturation: 0.85 - sparkle * 0.4, brightness: 1, alpha: 1)
                segment.lineWidth = 8
                color.withAlphaComponent(0.12 + sparkle * 0.1).setStroke()
                segment.stroke()
                segment.lineWidth = 3
                color.withAlphaComponent(0.78 + sparkle * 0.22).setStroke()
                segment.stroke()
            }
        }
    }
}

final class Overlay {
    var windows: [NSWindow] = []
    var active = 0
    var hidden = 0
    var expires = Date.distantPast
    var timer: Timer?
    init() {
        rebuild()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.rebuild() }
        timer = Timer.scheduledTimer(withTimeInterval: 1 / 60, repeats: true) { [weak self] _ in self?.update() }
    }
    func rebuild() {
        windows.forEach { $0.orderOut(nil) }
        windows = NSScreen.screens.map { screen in
            let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = false
            w.ignoresMouseEvents = true
            w.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)))
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            w.sharingType = .readOnly
            w.contentView = RainbowView(frame: NSRect(origin: .zero, size: screen.frame.size))
            return w
        }
        update()
    }
    func update() {
        let remaining = expires.timeIntervalSinceNow
        let visible = hidden == 0 && (active > 0 || remaining > 0)
        let mouse = NSEvent.mouseLocation
        for w in windows {
            if visible {
                w.alphaValue = active > 0 ? 1 : min(1, max(0, remaining / 0.35))
                let view = w.contentView as! RainbowView
                let next = w.frame.contains(mouse) ? NSPoint(x: mouse.x - w.frame.minX, y: mouse.y - w.frame.minY) : nil
                let now = Date.timeIntervalSinceReferenceDate
                // A stale previous sample would draw a trail the pointer never travelled.
                if let from = view.pointer, let to = next, now - view.lastSample < 0.25,
                   hypot(to.x - from.x, to.y - from.y) > 1.5 {
                    view.shed(from: from, to: to, at: now)
                }
                if next != nil { view.lastSample = now }
                view.tickSparkles(at: now)
                if next != nil || next != view.pointer {
                    for point in [view.pointer, next].compactMap({ $0 }) {
                        view.setNeedsDisplay(NSRect(x: point.x - 26, y: point.y - 26, width: 52, height: 52))
                    }
                    view.pointer = next
                }
                if !w.isVisible { w.orderFrontRegardless() }
            } else if w.isVisible {
                (w.contentView as! RainbowView).sparkles.removeAll()
                w.orderOut(nil)
            }
        }
    }
    func command(_ line: String) {
        let parts = line.split(separator: " ")
        guard parts.count == 2 else { return }
        switch parts[1] {
        case "begin": active += 1
        case "end": active = max(0, active - 1); expires = Date().addingTimeInterval(10)
        case "hide": hidden += 1
        case "show": hidden = max(0, hidden - 1)
        case "quit": NSApp.terminate(nil)
        default: break
        }
        update()
        // Allow the WindowServer to apply orderOut before a capture starts.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            print("\(parts[0]) \(self.windows.contains { $0.isVisible } ? 1 : 0) \(self.active) \(self.hidden) \(self.windows.count)"); fflush(stdout)
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let overlay = Overlay()
DispatchQueue.global().async {
    while let line = readLine() { DispatchQueue.main.async { overlay.command(line) } }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
