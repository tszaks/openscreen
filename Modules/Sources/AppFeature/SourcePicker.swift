import SwiftUI

/// Source picker — the app's home screen. Displays, windows, iOS devices,
/// and the synthetic demo source.
public struct SourcePickerView: View {
    @ObservedObject var appState: AppState
    @ObservedObject var controller: RecordingController
    @State private var selected: SourceOption?

    public init(appState: AppState, controller: RecordingController) {
        self.appState = appState
        self.controller = controller
    }

    public var body: some View {
        VStack(spacing: 20) {
            Text("OpenScreen")
                .font(.largeTitle.bold())
            Text("Pick a source to record")
                .foregroundStyle(.secondary)

            List(appState.availableSources, selection: $selected) { option in
                HStack {
                    Image(systemName: icon(for: option.kind))
                        .frame(width: 24)
                    VStack(alignment: .leading) {
                        Text(option.title)
                        if let subtitle = option.subtitle {
                            Text(subtitle).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .tag(option)
            }
            .frame(maxHeight: 320)

            Button("Start Recording") {
                guard let selected else { return }
                Task {
                    guard let inputs = await controller.inputs(
                        for: selected, outputDirectory: Self.newBundleURL()
                    ) else { return }
                    await controller.startRecording(inputs: inputs, appState: appState)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(selected == nil)

            if let error = appState.lastError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(32)
        .task {
            appState.availableSources = await controller.refreshSources()
        }
    }

    static func newBundleURL() -> URL {
        let dir = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("OpenScreen", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        return dir.appendingPathComponent("Recording-\(stamp).openscreen", isDirectory: true)
    }

    private func icon(for kind: SourceOption.Kind) -> String {
        switch kind {
        case .display: return "display"
        case .window: return "macwindow"
        case .region: return "rectangle.dashed"
        case .iosDevice: return "iphone"
        case .synthetic: return "wand.and.stars"
        }
    }
}
