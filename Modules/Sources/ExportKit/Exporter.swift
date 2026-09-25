import AVFoundation
import CoreGraphics
import CursorKit
import EditKit
import Foundation
import OpenScreenCore
import RenderKit

/// Frame-accurate offline render → mp4/mov.
public final class Exporter: @unchecked Sendable {
    public enum ExportError: Error, Sendable {
        case noFrames
        case writerFailed(String)
    }

    public struct Progress: Sendable {
        public var framesDone: Int
        public var framesTotal: Int
    }

    public init() {}

    /// Render the full project to `outputURL` at `project.outputFPS`.
    /// `frames(for:)`: supplies the decoded source frame at each source time —
    /// production uses PreviewRenderer's VideoFrameSource; tests use synthetics.
    public func export(
        bundle: RecordingBundle,
        timeline: Timeline,
        to outputURL: URL,
        frames: @Sendable (TimeInterval) -> CGImage?,
        progress: @Sendable (Progress) -> Void = { _ in }
    ) async throws {
        let project = bundle.project
        let canvas = Geometry.canvasSize(preset: project.exportPreset, source: project.recording.sourceSize)
        let fps = project.outputFPS
        let totalFrames = Int(timeline.outputDuration * Double(fps))
        guard totalFrames > 0 else { throw ExportError.noFrames }

        try? FileManager.default.removeItem(at: outputURL)
        let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)
        let codec: AVVideoCodecType = project.exportPreset == .uhd4k ? .hevc : .h264
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: codec,
            AVVideoWidthKey: Int(canvas.width),
            AVVideoHeightKey: Int(canvas.height),
        ])
        input.expectsMediaDataInRealTime = false
        writer.add(input)

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: Int(canvas.width),
                kCVPixelBufferHeightKey as String: Int(canvas.height),
            ]
        )

        guard writer.startWriting() else {
            throw ExportError.writerFailed(writer.error?.localizedDescription ?? "start failed")
        }
        writer.startSession(atSourceTime: .zero)

        let compositor = Compositor(project: project)
        let smoother = CursorSmoother(step: 1.0 / Double(fps))
        let rawSamples = (try? bundle.loadCursorSamples()) ?? []
        let smoothed = smoother.smoothedPath(from: rawSamples)

        for i in 0..<totalFrames {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            let outT = Double(i) / Double(fps)
            guard let sourceT = timeline.sourceTime(atOutputTime: outT) else { continue }
            guard let screen = frames(sourceT) else { continue }

            let cursorPos = nearestPosition(at: outT, in: smoothed)
            let input_ = FrameInput(
                screenFrame: screen,
                cameraFrame: nil,
                cursorPosition: cursorPos,
                cursorVisible: true
            )
            if let img = compositor.render(at: outT, input: input_),
               let buf = img.pixelBuffer(width: Int(canvas.width), height: Int(canvas.height)) {
                let pts = CMTime(seconds: outT, preferredTimescale: 600)
                if !adaptor.append(buf, withPresentationTime: pts) {
                    throw ExportError.writerFailed(
                        "append failed at frame \(i): \(writer.error?.localizedDescription ?? "?") status=\(writer.status.rawValue)"
                    )
                }
            }
            progress(Progress(framesDone: i + 1, framesTotal: totalFrames))
        }

        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed {
            throw ExportError.writerFailed(writer.error?.localizedDescription ?? "finish failed")
        }
    }

    private func nearestPosition(at time: TimeInterval, in samples: [CursorSample]) -> CGPointValue {
        guard !samples.isEmpty else { return CGPointValue(x: 0.5, y: 0.5) }
        var best = samples[0]
        var bestDelta = abs(best.time - time)
        for s in samples where abs(s.time - time) < bestDelta {
            best = s
            bestDelta = abs(s.time - time)
        }
        return CGPointValue(x: best.x, y: best.y)
    }
}

extension CGImage {
    /// Copy into a CVPixelBuffer for the asset writer.
    func pixelBuffer(width: Int, height: Int) -> CVPixelBuffer? {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(
            kCFAllocatorDefault, width, height,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary,
            &pb
        )
        guard let buffer = pb else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let ctx = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer),
            width: width, height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.draw(self, in: CGRect(x: 0, y: 0, width: width, height: height))
        return buffer
    }
}
