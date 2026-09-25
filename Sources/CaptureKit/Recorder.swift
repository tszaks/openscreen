@preconcurrency import AVFoundation
import Foundation
import OpenScreenCore
@preconcurrency import ScreenCaptureKit

/// What the user picked to record.
public struct RecordingInputs: Sendable {
    public enum Source: Sendable {
        case display(SCDisplay)
        case window(SCWindow)
        case region(SCDisplay, CGRect)
        /// USB-connected iPhone/iPad (continuity capture device).
        case iosDevice(AVCaptureDevice)
        /// Unit tests / synthetic pipeline.
        case synthetic
    }

    public var source: Source
    public var outputDirectory: URL
    public var includeCamera: Bool
    public var includeMicrophone: Bool
    public var includeSystemAudio: Bool
    /// Hide the system cursor during capture so RenderKit can draw its own.
    public var hideSystemCursor: Bool

    public init(
        source: Source,
        outputDirectory: URL,
        includeCamera: Bool = false,
        includeMicrophone: Bool = true,
        includeSystemAudio: Bool = true,
        hideSystemCursor: Bool = true
    ) {
        self.source = source
        self.outputDirectory = outputDirectory
        self.includeCamera = includeCamera
        self.includeMicrophone = includeMicrophone
        self.includeSystemAudio = includeSystemAudio
        self.hideSystemCursor = hideSystemCursor
    }
}

/// Anything that can produce a `RecordingBundle`.
public protocol Recorder: Sendable {
    func start() async throws
    func stop() async throws -> RecordingBundle
}

/// Errors surfaced to the UI when capture can't start.
public enum CaptureError: Error, Sendable {
    case screenRecordingNotPermitted
    case deviceNotFound
    case writerFailed(String)
    case syntheticUnsupported
}

/// Samples cursor position + click/drag events at a fixed rate while recording.
/// Uses NSEvent monitors (no Accessibility permission needed for position;
/// clicks need the app to see events — monitor covers both local and global
/// while our process owns the menu bar session).
public final class CursorMonitor: @unchecked Sendable {
    public private(set) var samples: [CursorSample] = []
    private var timer: Timer?
    private var monitors: [Any] = []
    private var startDate: Date = .distantPast
    private let queue = DispatchQueue(label: "openscreen.cursor-monitor")
    private let sampleRate: TimeInterval

    public init(sampleRate: TimeInterval = 1.0 / 120.0) {
        self.sampleRate = sampleRate
    }

    public func start(screenSize: CGSizeValue) {
        startDate = Date()
        let handler: (NSEvent) -> Void = { [weak self] event in
            self?.record(event: event, screenSize: screenSize)
        }
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseDown, .leftMouseUp], handler: handler) as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseDown, .leftMouseUp]) { event in
            handler(event)
            return event
        } as Any)
        // High-frequency position sampler for smooth paths even without events.
        timer = Timer.scheduledTimer(withTimeInterval: sampleRate, repeats: true) { [weak self] _ in
            self?.samplePosition(screenSize: screenSize)
        }
    }

    public func stop() -> [CursorSample] {
        timer?.invalidate()
        timer = nil
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors.removeAll()
        return samples.sorted { $0.time < $1.time }
    }

    private func samplePosition(screenSize: CGSizeValue) {
        let loc = NSEvent.mouseLocation
        let t = Date().timeIntervalSince(startDate)
        queue.async { [self] in
            samples.append(CursorSample(
                time: t,
                x: loc.x / screenSize.width,
                y: 1 - loc.y / screenSize.height // screen Y is bottom-up; store top-down
            ))
        }
    }

    private func record(event: NSEvent, screenSize: CGSizeValue) {
        let loc = NSEvent.mouseLocation
        let t = Date().timeIntervalSince(startDate)
        let kind: CursorSample.Kind = switch event.type {
        case .leftMouseDown: .clickDown
        case .leftMouseUp: .clickUp
        case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: .dragMove
        default: .move
        }
        queue.async { [self] in
            samples.append(CursorSample(
                time: t,
                x: loc.x / screenSize.width,
                y: 1 - loc.y / screenSize.height,
                kind: kind
            ))
        }
    }
}
