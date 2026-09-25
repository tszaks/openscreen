import AVFoundation
import CoreGraphics
import Foundation
import OpenScreenCore

/// Deterministic permissionless recorder for tests/CI: synthesizes a "recording"
/// (animated screen + cursor track) so the whole pipeline can run without TCC.
public final class SyntheticRecorder: Recorder, @unchecked Sendable {
    private let inputs: RecordingInputs
    private var startedAt: Date?
    private let outputURL: URL

    public init(inputs: RecordingInputs) {
        self.inputs = inputs
        self.outputURL = inputs.outputDirectory.appendingPathComponent("screen.mp4")
    }

    public func start() async throws {
        startedAt = Date()
    }

    /// Writes a short synthetic clip (default 4s @ 1280×720) + scripted cursor
    /// track with a few clicks, then returns the bundle.
    public func stop() async throws -> RecordingBundle {
        guard startedAt != nil else { throw CaptureError.writerFailed("not started") }
        let duration: TimeInterval = 4.0
        let size = CGSizeValue(width: 1280, height: 720)
        let fps = 30
        let frames = Int(duration) * fps

        try await writeSyntheticVideo(frames: frames, fps: fps, size: size, to: outputURL)

        // Scripted cursor: sweep across with two click pulses → exercises
        // smoothing + zoom planning downstream.
        var samples: [CursorSample] = []
        var t: TimeInterval = 0
        while t < duration {
            let p = t / duration
            samples.append(CursorSample(
                time: t,
                x: 0.15 + 0.7 * p,
                y: 0.3 + 0.3 * sin(p * .pi * 2),
                kind: .move
            ))
            t += 1.0 / 30.0
        }
        for clickT in [0.8, 2.2] {
            let idx = Int(clickT * 30)
            let pos = samples[min(idx, samples.count - 1)]
            samples.append(CursorSample(time: clickT, x: pos.x, y: pos.y, kind: .clickDown))
            samples.append(CursorSample(time: clickT + 0.08, x: pos.x, y: pos.y, kind: .clickUp))
        }

        var project = Project(
            recording: RecordingRef(
                screenVideoFile: "screen.mp4",
                audioFile: nil,
                sourceKind: .synthetic,
                sourceSize: size,
                duration: duration
            ),
            clips: [Clip(sourceStart: 0, sourceEnd: duration)]
        )
        project.style.paddingFraction = 0.12

        let bundle = RecordingBundle(directory: inputs.outputDirectory, project: project)
        try bundle.saveCursorSamples(samples)
        try bundle.save()
        return bundle
    }

    private func writeSyntheticVideo(frames: Int, fps: Int, size: CGSizeValue, to url: URL) async throws {
        let writer = try AVAssetWriter(url: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
        ])
        input.expectsMediaDataInRealTime = false
        writer.add(input)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: Int(size.width),
                kCVPixelBufferHeightKey as String: Int(size.height),
            ]
        )
        guard writer.startWriting() else {
            throw CaptureError.writerFailed(writer.error?.localizedDescription ?? "start failed")
        }
        writer.startSession(atSourceTime: .zero)

        let w = Int(size.width), h = Int(size.height)
        let space = CGColorSpaceCreateDeviceRGB()
        for i in 0..<frames {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 500_000)
            }
            guard let ctx = CGContext(
                data: nil, width: w, height: h,
                bitsPerComponent: 8, bytesPerRow: 0,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { continue }
            // Dark background + moving orange block so frames differ.
            ctx.setFillColor(CGColor(red: 0.1, green: 0.1, blue: 0.35, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.setFillColor(CGColor(red: 0.9, green: 0.4, blue: 0.2, alpha: 1))
            let bx = CGFloat(i % max(frames / 4, 1)) / CGFloat(max(frames / 4, 1)) * CGFloat(w - 120)
            ctx.fill(CGRect(x: bx, y: CGFloat(h) / 3, width: 120, height: 120))
            guard let frame = ctx.makeImage() else { continue }
            var pb: CVPixelBuffer?
            CVPixelBufferCreate(
                kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA,
                [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary,
                &pb
            )
            guard let buffer = pb else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let bctx = CGContext(
                data: CVPixelBufferGetBaseAddress(buffer),
                width: w, height: h,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) {
                bctx.draw(frame, in: CGRect(x: 0, y: 0, width: w, height: h))
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(seconds: Double(i) / Double(fps), preferredTimescale: CMTimeScale(fps)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed {
            throw CaptureError.writerFailed(writer.error?.localizedDescription ?? "finish failed")
        }
    }
}
