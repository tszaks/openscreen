import AVFoundation
import CoreMedia
import Foundation
import OpenScreenCore

/// Records a USB-connected iPhone/iPad via AVCaptureSession — the same path
/// QuickTime uses for "iPhone" movie recording (continuity capture device).
/// Screen Mirror on the device streams its display over USB.
public final class IOSDeviceRecorder: NSObject, Recorder, @unchecked Sendable {
    private let inputs: RecordingInputs
    private var session: AVCaptureSession?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var sessionStartTime: CMTime?
    private var recordedSize = CGSizeValue(width: 0, height: 0)
    private let outputURL: URL
    private var device: AVCaptureDevice?

    public init(inputs: RecordingInputs) {
        self.inputs = inputs
        self.outputURL = inputs.outputDirectory.appendingPathComponent("screen.mp4")
    }

    public func start() async throws {
        guard case let .iosDevice(device) = inputs.source else {
            throw CaptureError.deviceNotFound
        }
        self.device = device
        try FileManager.default.createDirectory(at: inputs.outputDirectory, withIntermediateDirectories: true)

        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }

        let session = AVCaptureSession()
        session.beginConfiguration()
        session.sessionPreset = .high

        let videoInput = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(videoInput) else { throw CaptureError.deviceNotFound }
        session.addInput(videoInput)

        let videoOutput = AVCaptureVideoDataOutput()
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        videoOutput.setSampleBufferDelegate(self, queue: DispatchQueue(label: "openscreen.ios.video"))
        session.addOutput(videoOutput)

        if inputs.includeSystemAudio || inputs.includeMicrophone {
            if let audioDevice = AVCaptureDevice.default(for: .audio),
               let audioInput = try? AVCaptureDeviceInput(device: audioDevice),
               session.canAddInput(audioInput) {
                session.addInput(audioInput)
                let audioOutput = AVCaptureAudioDataOutput()
                audioOutput.setSampleBufferDelegate(self, queue: DispatchQueue(label: "openscreen.ios.audio"))
                session.addOutput(audioOutput)
            }
        }

        session.commitConfiguration()
        session.startRunning()
        self.session = session
    }

    public func stop() async throws -> RecordingBundle {
        session?.stopRunning()
        session = nil
        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        await writer?.finishWriting()

        let asset = AVURLAsset(url: outputURL)
        let duration = (try? await asset.load(.duration).seconds) ?? 0
        let project = Project(
            recording: RecordingRef(
                screenVideoFile: "screen.mp4",
                sourceKind: .iosDevice,
                sourceSize: recordedSize,
                duration: duration
            ),
            clips: [Clip(sourceStart: 0, sourceEnd: duration)]
        )
        let bundle = RecordingBundle(directory: inputs.outputDirectory, project: project)
        try bundle.save()
        return bundle
    }

    private func ensureWriter(for sampleBuffer: CMSampleBuffer) throws {
        guard writer == nil, let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        let dims = CMVideoFormatDescriptionGetDimensions(formatDesc)
        recordedSize = CGSizeValue(width: Double(dims.width), height: Double(dims.height))
        let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(dims.width),
            AVVideoHeightKey: Int(dims.height),
        ])
        vInput.expectsMediaDataInRealTime = true
        writer.add(vInput)
        self.videoInput = vInput
        self.writer = writer
        writer.startWriting()
        writer.startSession(atSourceTime: sampleBuffer.presentationTimeStamp)
    }
}

extension IOSDeviceRecorder: AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        do {
            try ensureWriter(for: sampleBuffer)
        } catch {
            return
        }
        guard let writer, writer.status == .writing else { return }
        if output is AVCaptureVideoDataOutput, videoInput?.isReadyForMoreMediaData == true {
            videoInput?.append(sampleBuffer)
        } else if output is AVCaptureAudioDataOutput {
            if audioInput == nil {
                let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: 48000,
                    AVNumberOfChannelsKey: 2,
                ])
                aInput.expectsMediaDataInRealTime = true
                if writer.canAdd(aInput) { writer.add(aInput) }
                self.audioInput = aInput
            }
            if audioInput?.isReadyForMoreMediaData == true {
                audioInput?.append(sampleBuffer)
            }
        }
    }
}
