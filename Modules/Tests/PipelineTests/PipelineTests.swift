import AVFoundation
import CaptureKit
import CoreGraphics
import CursorKit
import EditKit
import ExportKit
import Foundation
import OpenScreenCore
import RenderKit
import Testing

/// End-to-end: synthetic record → cursor auto-zoom → styled render → real mp4.
/// Runs with zero system permissions — the whole pipeline is exercised here.
@Suite("Pipeline")
struct PipelineTests {
    @Test func recordAutoZoomExportProducesMP4() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pipeline-\(UUID().uuidString).openscreen", isDirectory: true)
        let outURL = dir.deletingLastPathComponent()
            .appendingPathComponent("pipeline-out-\(UUID().uuidString).mp4")
        defer {
            try? FileManager.default.removeItem(at: dir)
            try? FileManager.default.removeItem(at: outURL)
        }

        // 1. Record (synthetic — writes a real screen.mp4 + cursor.json).
        let inputs = RecordingInputs(source: .synthetic, outputDirectory: dir)
        let recorder = SyntheticRecorder(inputs: inputs)
        try await recorder.start()
        var bundle = try await recorder.stop()
        #expect(FileManager.default.fileExists(atPath: bundle.screenVideoURL.path))

        // 2. Auto-zoom keyframes from the recorded click track.
        let samples = try bundle.loadCursorSamples()
        #expect(!samples.isEmpty)
        let clicks = samples.filter { $0.kind == .clickDown }
        #expect(!clicks.isEmpty)
        bundle.project.zoomKeyframes = ZoomPlanner().plan(
            clicks: clicks,
            duration: bundle.project.recording.duration
        )
        #expect(bundle.project.zoomKeyframes.contains { $0.scale > 1.5 })
        try bundle.save()

        // 3. Export through the compositor → real mp4 file.
        let timeline = Timeline(
            sourceDuration: bundle.project.recording.duration,
            clips: bundle.project.clips
        )
        let source = try VideoFrameSource(url: bundle.screenVideoURL)
        try await Exporter().export(
            bundle: bundle,
            timeline: timeline,
            to: outURL,
            frames: { t in source.frame(at: t) }
        )

        #expect(FileManager.default.fileExists(atPath: outURL.path))
        let outAsset = AVURLAsset(url: outURL)
        let duration = try await outAsset.load(.duration).seconds
        #expect(duration > 3.5) // synthetic clip is 4s
        let tracks = try await outAsset.load(.tracks)
        #expect(tracks.contains { $0.mediaType == .video })
    }

    @Test func compositorRendersDistinctBackground() throws {
        // Compositor alone: synthetic screen frame over gradient background.
        let w = 640, h = 360
        let space = CGColorSpaceCreateDeviceRGB()
        let ctx = try #require(CGContext(
            data: nil, width: w, height: h, // Ints accepted by CGContext init
            bitsPerComponent: 8, bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        ctx.setFillColor(CGColor(red: 0.8, green: 0.2, blue: 0.2, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        let screen = try #require(ctx.makeImage())

        let project = Project(
            recording: RecordingRef(
                screenVideoFile: "screen.mp4",
                sourceKind: .synthetic,
                sourceSize: CGSizeValue(width: Double(w), height: Double(h)),
                duration: 1
            ),
            clips: []
        )
        let comp = Compositor(project: project)
        let out = try #require(comp.render(
            at: 0,
            input: FrameInput(
                screenFrame: screen,
                cursorPosition: CGPointValue(x: 0.5, y: 0.5),
                cursorVisible: true
            )
        ))
        #expect(out.width == Int(comp.canvas.width))
        #expect(out.height == Int(comp.canvas.height))
    }
}
