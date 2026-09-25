import AVFoundation
import Foundation
import OpenScreenCore
import ScreenCaptureKit

/// ScreenCaptureKit display/window/region recorder → mp4 + cursor track.
///
/// TCC note: Screen Recording permission is required for real capture;
/// on a permissionless machine `start()` throws `.screenRecordingNotPermitted`.
/// The pipeline is exercised end-to-end by `SyntheticRecorder` instead.
public final class DisplayRecorder: NSObject, Recorder, @unchecked Sendable {
    private let inputs: RecordingInputs
    private let cursorMonitor = CursorMonitor()
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var micInput: AVAssetWriterInput?
    private let outputURL: URL
    private var bundle: RecordingBundle?

    public init(inputs: RecordingInputs) {
        self.inputs = inputs
        self.outputURL = inputs.outputDirectory.appendingPathComponent("screen.mp4")
    }

    public func start() async throws {
        let config = SCStreamConfiguration()
        config.width = 0 // 0 → native
        config.height = 0
        config.capturesAudio = inputs.includeSystemAudio
        config.excludesCurrentProcessAudio = true
        config.showsCursor = !inputs.hideSystemCursor
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.queueDepth = 8

        let filter: SCContentFilter
        var sourceKind: RecordingRef.SourceKind = .display
        var sourceSize = CGSizeValue(width: 1920, height: 1080)

        switch inputs.source {
        case let .display(display):
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let panel = SCContentFilter(display: display, excludingWindows: [])
            filter = panel
            sourceKind = .display
            sourceSize = CGSizeValue(width: Double(display.width), height: Double(display.height))
            _ = content
        case let .window(window):
            filter = SCContentFilter(desktopIndependentWindow: window)
            sourceKind = .window
            sourceSize = CGSizeValue(width: window.frame.width, height: window.frame.height)
        case let .region(display, rect):
            filter = SCContentFilter(display: display, excludingWindows: [])
            config.sourceRect = rect
            config.width = Int(rect.width * 2) // retina
            config.height = Int(rect.height * 2)
            sourceKind = .region
            sourceSize = CGSizeValue(width: rect.width * 2, height: rect.height * 2)
        case .iosDevice, .synthetic:
            throw CaptureError.syntheticUnsupported
        }

        // Writer.
        try FileManager.default.createDirectory(at: inputs.outputDirectory, withIntermediateDirectories: true)
        let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)
        let vSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(sourceSize.width),
            AVVideoHeightKey: Int(sourceSize.height),
        ]
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: vSettings)
        vInput.expectsMediaDataInRealTime = true
        writer.add(vInput)
        self.videoInput = vInput

        if inputs.includeSystemAudio {
            let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
            ])
            aInput.expectsMediaDataInRealTime = true
            writer.add(aInput)
            self.audioInput = aInput
        }

        self.writer = writer

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "openscreen.sck.video"))
        if inputs.includeSystemAudio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "openscreen.sck.audio"))
        }
        try await stream.startCapture()
        self.stream = stream

        cursorMonitor.start(screenSize: sourceSize)

        var project = Project(
            recording: RecordingRef(
                screenVideoFile: "screen.mp4",
                cameraVideoFile: inputs.includeCamera ? "camera.mp4" : nil,
                audioFile: "screen.mp4",
                sourceKind: sourceKind,
                sourceSize: sourceSize,
                duration: 0
            ),
            clips: []
        )
        project.cameraOverlay.enabled = inputs.includeCamera
        self.bundle = RecordingBundle(directory: inputs.outputDirectory, project: project)
    }

    public func stop() async throws -> RecordingBundle {
        if let stream { try await stream.stopCapture() }
        stream = nil
        let samples = cursorMonitor.stop()

        guard var bundle else { throw CaptureError.writerFailed("not started") }
        let asset = AVURLAsset(url: outputURL)
        let duration = (try? await asset.load(.duration).seconds) ?? 0
        bundle.project.recording.duration = duration
        bundle.project.clips = [Clip(sourceStart: 0, sourceEnd: duration)]
        try bundle.saveCursorSamples(samples)
        try bundle.save()
        return bundle
    }
}

extension DisplayRecorder: SCStreamOutput {
    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard let writer else { return }
        if writer.status == .unknown {
            writer.startWriting()
            writer.startSession(atSourceTime: sampleBuffer.presentationTimeStamp)
        }
        guard writer.status == .writing else { return }
        switch type {
        case .screen:
            if videoInput?.isReadyForMoreMediaData == true {
                videoInput?.append(sampleBuffer)
            }
        case .audio:
            if audioInput?.isReadyForMoreMediaData == true {
                audioInput?.append(sampleBuffer)
            }
        case .microphone:
            if micInput?.isReadyForMoreMediaData == true {
                micInput?.append(sampleBuffer)
            }
        @unknown default:
            break
        }
    }
}

/// Enumerate USB-connected iPhone/iPad capture devices — the same devices
/// QuickTime exposes for "iPhone" movie recording. Spike target: prove the
/// device appears and produces frames on this hardware.
public enum IOSDeviceDiscovery {
    public static func connectedDevices() -> [AVCaptureDevice] {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external],
            mediaType: .video,
            position: .unspecified
        )
        return discovery.devices
    }
}
