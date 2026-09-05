import AppKit

final class FixtureController: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let statusField = NSTextField(labelWithString: "Bereit")
    private let inputField = NSTextField(string: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--trace-events") {
            NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .keyDown]) { event in
                // Log event kinds/positions only; do not record typed contents.
                print("fixture-event", event.type.rawValue, event.locationInWindow)
                fflush(stdout)
                return event
            }
        }
        let contentRect = NSRect(x: 0, y: 0, width: 600, height: 400)
        window = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false,
        )
        window.title = "Computer Use Intel – Testfenster"
        window.isReleasedWhenClosed = false

        let content = NSView(frame: contentRect)
        window.contentView = content

        let heading = NSTextField(labelWithString: "Computer Use Intel – Testfenster")
        heading.font = NSFont.boldSystemFont(ofSize: 20)
        heading.alignment = .center
        heading.setAccessibilityLabel("Computer Use Intel – Testfenster")
        heading.frame = NSRect(x: 24, y: 334, width: 552, height: 30)
        content.addSubview(heading)

        statusField.font = NSFont.systemFont(ofSize: 18)
        statusField.alignment = .center
        statusField.setAccessibilityLabel("Status")
        statusField.setAccessibilityTitle("Status")
        statusField.frame = NSRect(x: 24, y: 278, width: 552, height: 32)
        content.addSubview(statusField)

        let inputLabel = NSTextField(labelWithString: "Prüftext")
        inputLabel.frame = NSRect(x: 24, y: 228, width: 552, height: 24)
        content.addSubview(inputLabel)

        inputField.isEditable = true
        inputField.isSelectable = true
        inputField.isBezeled = true
        inputField.drawsBackground = true
        inputField.placeholderString = "Unicode-Prüftext"
        inputField.setAccessibilityLabel("Prüftext")
        inputField.setAccessibilityTitle("Prüftext")
        inputField.frame = NSRect(x: 24, y: 184, width: 552, height: 34)
        content.addSubview(inputField)

        let startButton = NSButton(title: "Prüfung starten", target: self, action: #selector(startTest))
        startButton.bezelStyle = .rounded
        startButton.setAccessibilityLabel("Prüfung starten")
        startButton.frame = NSRect(x: 24, y: 116, width: 250, height: 36)
        content.addSubview(startButton)

        let resetButton = NSButton(title: "Zurücksetzen", target: self, action: #selector(resetTest))
        resetButton.bezelStyle = .rounded
        resetButton.setAccessibilityLabel("Zurücksetzen")
        resetButton.frame = NSRect(x: 326, y: 116, width: 250, height: 36)
        content.addSubview(resetButton)

        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func startTest() {
        statusField.stringValue = "Klick bestätigt"
    }

    @objc private func resetTest() {
        statusField.stringValue = "Bereit"
        inputField.stringValue = ""
    }
}

let application = NSApplication.shared
let delegate = FixtureController()
application.delegate = delegate
application.setActivationPolicy(.regular)
// AppKit's delegate and button targets are weak. Keep the controller alive
// even in an optimized standalone Swift executable.
withExtendedLifetime(delegate) { application.run() }
