import AVFoundation
import CursorKit
import EditKit
import OpenScreenCore
import RenderKit
import SwiftUI

/// Editor: scrubbing preview + timeline + style panel + export.
public struct EditorView: View {
    @ObservedObject var appState: AppState
    @StateObject private var model: EditorModel

    public init(appState: AppState, bundleURL: URL) {
        self.appState = appState
        _model = StateObject(wrappedValue: EditorModel(bundleURL: bundleURL))
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let frame = model.previewImage {
                Image(decorative: frame, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxHeight: 420)
            } else {
                Rectangle()
                    .fill(.black.opacity(0.85))
                    .frame(height: 320)
                    .overlay { ProgressView() }
            }

            Slider(
                value: Binding(
                    get: { model.playhead },
                    set: { model.seek(to: $0) }
                ),
                in: 0...max(model.timeline.outputDuration, 0.001)
            )
            .padding(.horizontal)

            TimelineBar(timeline: model.timeline, playhead: model.playhead) { action in
                model.apply(action)
            }
            .frame(height: 72)

            HStack {
                StylePanel(project: model.bundle.project) { style in
                    model.updateStyle(style)
                }
                Spacer()
                Button("Export") { Task { await model.export(appState: appState) } }
                    .buttonStyle(.borderedProminent)
            }
            .padding()
        }
        .task { await model.load() }
    }
}

/// Timeline strip: clips as colored segments, playhead line, edit actions.
struct TimelineBar: View {
    let timeline: Timeline
    let playhead: TimeInterval
    let onAction: (EditorModel.Action) -> Void

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                HStack(spacing: 1) {
                    ForEach(timeline.clips) { clip in
                        let fraction = clip.outputDuration / max(timeline.outputDuration, 0.001)
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.accentColor.opacity(0.7))
                            .frame(width: max(4, CGFloat(fraction) * geo.size.width))
                            .overlay(alignment: .trailing) {
                                if clip.speed != 1 {
                                    Text("×\(clip.speed, specifier: "%.2g")")
                                        .font(.caption2)
                                        .foregroundStyle(.white)
                                        .padding(.trailing, 4)
                                }
                            }
                    }
                }
                Rectangle()
                    .fill(Color.white)
                    .frame(width: 2)
                    .offset(x: CGFloat(playhead / max(timeline.outputDuration, 0.001)) * geo.size.width)
            }
        }
        .padding(.horizontal)
        .overlay(alignment: .bottomLeading) {
            HStack(spacing: 12) {
                Button("Split at playhead") { onAction(.split) }
                    .font(.caption)
                Button("Auto-zoom on clicks") { onAction(.autoZoom) }
                    .font(.caption)
            }
            .padding(.leading)
        }
    }
}

/// Panel for style tweaks (padding, corner radius).
struct StylePanel: View {
    let project: Project
    let onChange: (StyleSettings) -> Void
    @State private var padding: Double
    @State private var cornerRadius: Double

    init(project: Project, onChange: @escaping (StyleSettings) -> Void) {
        self.project = project
        self.onChange = onChange
        _padding = State(initialValue: project.style.paddingFraction)
        _cornerRadius = State(initialValue: project.style.cornerRadius)
    }

    var body: some View {
        HStack(spacing: 16) {
            LabeledContent("Padding") {
                Slider(value: $padding, in: 0...0.4, step: 0.01)
                    .frame(width: 120)
                    .onChange(of: padding) { _, v in push { $0.paddingFraction = v } }
            }
            LabeledContent("Corner") {
                Slider(value: $cornerRadius, in: 0...64, step: 1)
                    .frame(width: 100)
                    .onChange(of: cornerRadius) { _, v in push { $0.cornerRadius = v } }
            }
        }
    }

    private func push(_ mutate: (inout StyleSettings) -> Void) {
        var style = project.style
        mutate(&style)
        onChange(style)
    }
}
