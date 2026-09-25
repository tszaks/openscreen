import AppKit
import Foundation
import ScreenCaptureKit

/// Full-screen translucent overlay for drag-selecting a capture region.
/// Presents as a borderless window above everything; drag → rect in
/// SCDisplay pixel coordinates, Escape cancels.
@MainActor
public final class RegionPicker {
    public init() {}

    /// Show the overlay over `screen`'s display; returns the selected rect
    /// in *display pixel* coordinates (CG, bottom-up origin) or nil on cancel.
    public func pickRegion(on screen: NSScreen) async -> CGRect? {
        await withCheckedContinuation { cont in
            let overlay = RegionOverlayWindow(screen: screen) { rect in
                cont.resume(returning: rect)
            }
            overlay.show()
        }
    }
}

private final class RegionOverlayWindow: NSWindow {
    private let completion: (CGRect?) -> Void
    private var didFinish = false

    init(screen: NSScreen, completion: @escaping (CGRect?) -> Void) {
        self.completion = completion
        super.init(
            contentRect: screen.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        level = .screenSaver
        isOpaque = false
        backgroundColor = .clear
        ignoresMouseEvents = false
        acceptsMouseMovedEvents = true
        let view = RegionSelectView(frame: NSRect(origin: .zero, size: screen.frame.size)) { [weak self] rect in
            self?.finish(rect)
        }
        contentView = view
    }

    func show() {
        makeKeyAndOrderFront(nil)
        NSCursor.crosshair.push()
    }

    func finish(_ rect: CGRect?) {
        guard !didFinish else { return }
        didFinish = true
        NSCursor.pop()
        close()
        completion(rect)
    }
}

private final class RegionSelectView: NSView {
    private let done: (CGRect?) -> Void
    private var start: NSPoint?
    private var current: NSPoint?

    init(frame: NSRect, done: @escaping (CGRect?) -> Void) {
        self.done = done
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { done(nil) } // Escape
        else { super.keyDown(with: event) }
    }

    override func mouseDown(with event: NSEvent) {
        start = convert(event.locationInWindow, from: nil)
        current = start
    }

    override func mouseDragged(with event: NSEvent) {
        current = convert(event.locationInWindow, from: nil)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard let start, let current else { done(nil); return }
        let rect = normalizedRect(start, current)
        // Too small → treat as cancel.
        done(rect.width > 8 && rect.height > 8 ? rect : nil)
    }

    private func normalizedRect(_ a: NSPoint, _ b: NSPoint) -> CGRect {
        CGRect(
            x: min(a.x, b.x), y: min(a.y, b.y),
            width: abs(a.x - b.x), height: abs(a.y - b.y)
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.45).setFill()
        bounds.fill()
        guard let start, let current else { return }
        let rect = normalizedRect(start, current)
        // Cut the selected area out of the dim.
        NSColor.clear.setFill()
        rect.fill(using: .clear)
        NSColor.white.withAlphaComponent(0.9).setStroke()
        let path = NSBezierPath(rect: rect)
        path.lineWidth = 1.5
        path.stroke()
        let label = "\(Int(rect.width)) × \(Int(rect.height))"
        label.draw(
            at: NSPoint(x: rect.minX + 4, y: rect.maxY + 6),
            withAttributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
                .foregroundColor: NSColor.white,
            ]
        )
    }
}
