import AVFoundation
import CoreGraphics
import CursorKit
import EditKit
import ExportKit
import Foundation
import OpenScreenCore
import RenderKit
import SwiftUI

/// Mutable state for the editor: bundle + timeline + preview + export.
@MainActor
public final class EditorModel: ObservableObject {
    public enum Action {
        case split
        case autoZoom
        case clearZooms
    }

    @Published public private(set) var bundle: RecordingBundle
    @Published public private(set) var timeline: Timeline
    @Published public private(set) var previewImage: CGImage?
    @Published public var playhead: TimeInterval = 0

    private let bundleURL: URL
    private var previewRenderer: PreviewRenderer?
    private var cursorSamples: [CursorSample] = []

    public init(bundleURL: URL) {
        self.bundleURL = bundleURL
        let stub = Project(
            recording: RecordingRef(
                screenVideoFile: "screen.mp4",
                sourceKind: .synthetic,
                sourceSize: CGSizeValue(width: 1280, height: 720),
                duration: 0
            ),
            clips: []
        )
        self.bundle = RecordingBundle(directory: bundleURL, project: stub)
        self.timeline = Timeline(sourceDuration: 0, clips: [])
    }

    public func load() async {
        do {
            bundle = try RecordingBundle.load(from: bundleURL)
            timeline = Timeline(
                sourceDuration: bundle.project.recording.duration,
                clips: bundle.project.clips
            )
            cursorSamples = (try? bundle.loadCursorSamples()) ?? []
            previewRenderer = try PreviewRenderer(
                bundle: bundle,
                compositor: Compositor(project: bundle.project),
                cursorSamples: cursorSamples
            )
            renderPreview()
        } catch {
            // Keep placeholder bundle; UI shows error state via appState.
        }
    }

    public func seek(to time: TimeInterval) {
        playhead = time
        renderPreview()
    }

    public func apply(_ action: Action) {
        switch action {
        case .split:
            timeline.split(at: playhead)
        case .autoZoom:
            let planner = ZoomPlanner()
            let clicks = cursorSamples.filter { $0.kind == .clickDown }
            bundle.project.zoomKeyframes = planner.plan(
                clicks: clicks,
                duration: timeline.outputDuration
            )
        case .clearZooms:
            bundle.project.zoomKeyframes = []
        }
        renderPreview()
    }

    public func updateStyle(_ style: StyleSettings) {
        bundle.project.style = style
        renderPreview()
    }

    public func export(appState: AppState) async {
        let screenURL = bundle.directory.appendingPathComponent(bundle.project.recording.screenVideoFile)
        let frames = try? VideoFrameSource(url: screenURL)
        let output = bundleURL.deletingLastPathComponent()
            .appendingPathComponent("OpenScreen-export.mp4")
        let exporter = Exporter()
        appState.phase = .exporting(progress: 0)
        do {
            try await exporter.export(bundle: bundle, timeline: timeline, to: output, frames: { t in
                frames?.frame(at: t)
            }) { p in
                Task { @MainActor in
                    appState.phase = .exporting(progress: Double(p.framesDone) / Double(p.framesTotal))
                }
            }
            try? bundle.save()
            appState.phase = .editor(bundleURL: bundleURL)
            NSWorkspace.shared.activateFileViewerSelecting([output])
        } catch {
            appState.lastError = error.localizedDescription
            appState.phase = .editor(bundleURL: bundleURL)
        }
    }

    private func renderPreview() {
        guard let previewRenderer else { return }
        previewImage = previewRenderer.frame(at: playhead)
    }
}
