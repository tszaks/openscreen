import AVFoundation
import CoreGraphics
import Foundation
import OpenScreenCore

/// Live preview for the editor: decodes source frames on demand and runs them
/// through `Compositor` at display cadence. Same code path as export, just
/// on-demand instead of frame-accurate.
public final class PreviewRenderer: @unchecked Sendable {
    public let bundle: RecordingBundle
    public let compositor: Compositor

    private let videoReader: VideoFrameSource
    private let cameraReader: VideoFrameSource?
    private let cursorSamples: [CursorSample]

    public init(bundle: RecordingBundle, compositor: Compositor, cursorSamples: [CursorSample] = []) throws {
        self.bundle = bundle
        self.compositor = compositor
        self.cursorSamples = cursorSamples
        self.videoReader = try VideoFrameSource(url: bundle.screenVideoURL)
        self.cameraReader = try bundle.project.recording.cameraVideoFile
            .map { try VideoFrameSource(url: bundle.directory.appendingPathComponent($0)) }
    }

    /// Render the composited frame for output time `t`.
    public func frame(at outputTime: TimeInterval) -> CGImage? {
        guard let screenFrame = videoReader.frame(at: outputTime) else { return nil }
        let cursor = cursorPosition(at: outputTime)
        let input = FrameInput(
            screenFrame: screenFrame,
            cameraFrame: cameraReader?.frame(at: outputTime),
            cursorPosition: cursor,
            cursorVisible: true
        )
        return compositor.render(at: outputTime, input: input)
    }

    /// Nearest smoothed cursor position at `time` (linear scan is fine —
    /// editor preview, not export).
    private func cursorPosition(at time: TimeInterval) -> CGPointValue {
        guard !cursorSamples.isEmpty else { return CGPointValue(x: 0.5, y: 0.5) }
        var best = cursorSamples[0]
        var bestDelta = abs(best.time - time)
        for s in cursorSamples where abs(s.time - time) < bestDelta {
            best = s
            bestDelta = abs(s.time - time)
        }
        return CGPointValue(x: best.x, y: best.y)
    }
}

/// Random-access-ish frame source over a video file using AVAssetImageGenerator.
/// Sequential playback should move forward through `TimeRangeTolerance` cheaply;
/// this naive version is correct and simple — cache optimization comes later.
public struct VideoFrameSource: @unchecked Sendable {
    public let asset: AVAsset
    public let url: URL
    private let generator: AVAssetImageGenerator

    public init(url: URL) throws {
        self.url = url
        let asset = AVURLAsset(url: url)
        self.asset = asset
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore = .init(seconds: 0.05, preferredTimescale: 600)
        gen.requestedTimeToleranceAfter = .init(seconds: 0.05, preferredTimescale: 600)
        self.generator = gen
    }

    /// Synchronous frame grab; throws become nil (missing/out-of-range time).
    public func frame(at seconds: TimeInterval) -> CGImage? {
        let t = CMTime(seconds: seconds, preferredTimescale: 600)
        return try? generator.copyCGImage(at: t, actualTime: nil)
    }
}
