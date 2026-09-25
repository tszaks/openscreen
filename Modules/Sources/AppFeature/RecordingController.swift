import AppKit
import AVFoundation
import CaptureKit
import Foundation
import OpenScreenCore
import ScreenCaptureKit

/// Bridges AppState and CaptureKit: enumerates sources, runs the recording,
/// hands the finished bundle to the editor.
@MainActor
public final class RecordingController: ObservableObject {
    public private(set) var recorder: (any Recorder)?
    private var displays: [SCDisplay] = []
    private var windows: [SCWindow] = []

    public init() {}

    /// Enumerate available capture sources (displays, windows, iOS devices).
    /// Never throws — returns what the OS allows.
    public func refreshSources() async -> [SourceOption] {
        var options: [SourceOption] = []

        if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) {
            displays = content.displays
            windows = content.windows

            for display in content.displays {
                options.append(SourceOption(
                    id: "display-\(display.displayID)",
                    kind: .display,
                    title: "Display \(display.displayID)",
                    subtitle: "\(display.width)×\(display.height)"
                ))
            }
            for window in content.windows where window.title?.isEmpty == false {
                options.append(SourceOption(
                    id: "window-\(window.windowID)",
                    kind: .window,
                    title: window.owningApplication?.applicationName ?? "Window",
                    subtitle: window.title
                ))
            }
        }

        if !displays.isEmpty {
            options.append(SourceOption(
                id: "region",
                kind: .region,
                title: "Region…",
                subtitle: "drag to select an area"
            ))
        }

        for device in IOSDeviceDiscovery.connectedDevices() {
            options.append(SourceOption(
                id: "ios-\(device.uniqueID)",
                kind: .iosDevice,
                title: device.localizedName,
                subtitle: "USB capture"
            ))
        }

        options.append(SourceOption(
            id: "synthetic",
            kind: .synthetic,
            title: "Synthetic demo",
            subtitle: "no permissions needed — generated frames"
        ))
        return options
    }

    /// Resolve a picker option back to the concrete input object.
    /// For `.region` this shows the drag-select overlay — hence async.
    public func inputs(for option: SourceOption, outputDirectory: URL) async -> RecordingInputs? {
        var inputs = RecordingInputs(source: .synthetic, outputDirectory: outputDirectory)
        switch option.kind {
        case .display:
            guard let id = option.id.split(separator: "-").last.flatMap({ UInt32($0) }),
                  let display = displays.first(where: { $0.displayID == id })
            else { return nil }
            inputs.source = .display(display)
        case .window:
            guard let id = option.id.split(separator: "-").last.flatMap({ UInt32($0) }),
                  let window = windows.first(where: { $0.windowID == id })
            else { return nil }
            inputs.source = .window(window)
        case .region:
            guard let screen = NSScreen.main, let display = displays.first else { return nil }
            guard let rect = await RegionPicker().pickRegion(on: screen) else { return nil }
            inputs.source = .region(display, rect)
        case .iosDevice:
            guard let device = IOSDeviceDiscovery.connectedDevices()
                .first(where: { "ios-\($0.uniqueID)" == option.id })
            else { return nil }
            inputs.source = .iosDevice(device)
        case .synthetic:
            inputs.source = .synthetic
        }
        return inputs
    }

    public func startRecording(inputs: RecordingInputs, appState: AppState) async {
        do {
            let recorder = try makeRecorder(for: inputs)
            self.recorder = recorder
            try await recorder.start()
            appState.phase = .recording(startedAt: Date())
        } catch {
            appState.lastError = error.localizedDescription
        }
    }

    public func stopRecording(appState: AppState) async {
        guard let recorder else { return }
        do {
            let bundle = try await recorder.stop()
            self.recorder = nil
            appState.phase = .editor(bundleURL: bundle.directory)
        } catch {
            appState.lastError = error.localizedDescription
        }
    }

    private func makeRecorder(for inputs: RecordingInputs) throws -> any Recorder {
        switch inputs.source {
        case .synthetic:
            return SyntheticRecorder(inputs: inputs)
        case .iosDevice:
            return IOSDeviceRecorder(inputs: inputs)
        default:
            return DisplayRecorder(inputs: inputs)
        }
    }
}
