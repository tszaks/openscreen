import SwiftUI

/// Top-level view: routes by app phase.
public struct RootView: View {
    @StateObject private var appState = AppState()
    @StateObject private var controller = RecordingController()

    public init() {}

    public var body: some View {
        Group {
            switch appState.phase {
            case .sourcePicker:
                SourcePickerView(appState: appState, controller: controller)
            case let .recording(startedAt):
                RecordingView(
                    startedAt: startedAt,
                    onStop: { Task { await controller.stopRecording(appState: appState) } }
                )
            case let .editor(bundleURL):
                EditorView(appState: appState, bundleURL: bundleURL)
            case let .exporting(progress):
                ExportingView(progress: progress)
            }
        }
        .frame(minWidth: 720, minHeight: 520)
    }
}

/// Recording HUD: elapsed time + stop button.
struct RecordingView: View {
    let startedAt: Date
    let onStop: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "record.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.red)
            Text(startedAt, style: .timer)
                .font(.largeTitle.monospacedDigit())
            Button("Stop Recording", action: onStop)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
        .padding(48)
    }
}

/// Export progress screen.
struct ExportingView: View {
    let progress: Double

    var body: some View {
        VStack(spacing: 20) {
            Text("Exporting…")
                .font(.title2)
            ProgressView(value: progress)
                .frame(width: 320)
            Text("\(Int(progress * 100))%")
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .padding(48)
    }
}
