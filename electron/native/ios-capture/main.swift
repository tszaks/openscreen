// ios-capture: wired iPhone/iPad SCREEN capture, the way QuickTime's
// "New Movie Recording -> iPhone" does it.
//
// iOS screens only show up as capture devices after a process opts in via
// the CoreMediaIO property kCMIOHardwarePropertyAllowScreenCaptureDevices.
// Chromium never does that (and captures in its own utility process), so the
// Electron app drives this small helper instead.
//
//   ios-capture list [--wait ms]          one JSON array of devices, then exit
//   ios-capture record <uniqueID> <out>   record until SIGINT/SIGTERM, a
//                                         "stop" line, or EOF on stdin, then
//                                         exit. From a shell, keep stdin
//                                         open: `sleep 60 | ios-capture ..`
//   ios-capture serve                     long-lived; what the app uses
//   ios-capture selftest <out>            write a synthetic take (with a
//                                         mid-take rotation) through the
//                                         same writer; needs no device
//
// The opt-in blocks for up to ~5s in every new process, so the app keeps one
// `serve` process alive rather than paying that per poll or per recording.
//
// stdout is one JSON object per line:
//   {"event":"devices","devices":[{"id","name","modelID","manufacturer"}]}
//   {"event":"started","width":..,"height":..}
//       sent on the first video frame, with that frame's real size
//   {"event":"finished","path":..,"width":..,"height":..,"duration":..}
//   {"event":"error","message":..,"code":..}
//       "code" is optional. "no-frames": the session opened but no picture
//       arrived within 3s (phone locked, trust revoked, "Stop Mirroring"
//       tapped). The take is torn down and no file is left behind.
//   {"event":"warning","code":"stalled","message":..}
//       no new frame for 5s mid-take, usually because the phone locked.
//       Recording carries on; sent once per stall.
//   {"event":"warning","code":"resumed"}
//       frames are arriving again after "stalled".
// serve reads one command per line on stdin:
//   {"cmd":"record","id":"<uniqueID>","path":"/abs/out.mov"}
//   {"cmd":"stop"}      (a bare "stop" line also works)
//
// Why not AVCaptureMovieFileOutput: on an iOS-device session it washes the
// picture out (gamma, FB22281424), and rotating the phone mid-take ends the
// recording and saves nothing (FB21253500). Decoded frames go through
// AVAssetWriter instead, as H.264 High + AAC, tagged Rec.709.
//
// Rotation: the file keeps the first frame's size for the whole take. A
// frame of any other size (the phone rotated) is scaled to fit and centred
// on black with VTPixelTransferSession. One file, one size, no stitching,
// and the editor never sees a resolution change mid-video.
//
// Odd sizes: H.264 4:2:0 can only store even ones, so a 1179-wide phone
// gives a 1178-wide file. "started" reports what the phone sends;
// "finished" reports what the file holds.

import AVFoundation
import CoreMediaIO
import Foundation
import VideoToolbox

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func emitError(_ message: String) {
    emit(["event": "error", "message": message])
}

/// Opt this process into seeing iOS screen devices.
func allowScreenCaptureDevices() {
    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    let status = CMIOObjectSetPropertyData(
        CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil,
        UInt32(MemoryLayout<UInt32>.size), &allow)
    if status != 0 {
        FileHandle.standardError.write("ios-capture: CMIO opt-in failed (\(status))\n".data(using: .utf8)!)
    }
}

func screenDevices() -> [AVCaptureDevice] {
    let types: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) {
        types = [.external]
    } else {
        types = [.externalUnknown]
    }
    return AVCaptureDevice.DiscoverySession(
        deviceTypes: types, mediaType: .muxed, position: .unspecified
    ).devices
}

func describe(_ devices: [AVCaptureDevice]) -> [[String: String]] {
    devices.map {
        ["id": $0.uniqueID, "name": $0.localizedName, "modelID": $0.modelID, "manufacturer": $0.manufacturer]
    }
}

/// Spin the run loop (devices arrive on it) until `done` or the deadline.
func pump(until deadline: Date, done: () -> Bool) {
    while Date() < deadline && !done() {
        RunLoop.current.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.1)))
    }
}

/// Camera permission gate. Calls back on the main queue with nil when
/// allowed, or a user-facing reason when not.
func checkCameraAccess(_ done: @escaping (String?) -> Void) {
    let settings = "Allow OpenScreen in System Settings > Privacy & Security > Camera."
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        done(nil)
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async { done(ok ? nil : "Camera permission was not granted. \(settings)") }
        }
    case .denied:
        done("Camera permission is denied. \(settings)")
    case .restricted:
        done("Camera access is restricted on this Mac.")
    @unknown default:
        done("Camera permission status is unknown.")
    }
}

// MARK: - writing

struct AudioFormat {
    var sampleRate: Double = 48_000
    var channels = 2
}

func writerError(_ message: String) -> Error {
    NSError(domain: "ios-capture", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// AVAssetWriter for one take: H.264 High + AAC in a .mov (or .mp4) at one
/// fixed frame size; frames of another size are letterboxed into it. Not
/// thread-safe: drive it from one serial queue.
final class MovieWriter {
    let url: URL
    let width: Int
    let height: Int
    private let writer: AVAssetWriter
    private let video: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let audio: AVAssetWriterInput?
    let startPTS: CMTime
    private var transfer: VTPixelTransferSession?
    private(set) var lastVideoPTS = CMTime.invalid

    init(url: URL, width: Int, height: Int, startPTS: CMTime, audio audioFormat: AudioFormat?) throws {
        self.url = url
        self.width = width
        self.height = height
        self.startPTS = startPTS
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(url: url, fileType: url.pathExtension.lowercased() == "mp4" ? .mp4 : .mov)

        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, // Chromium can't decode HEVC
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            // The phone sends sRGB; tag it so Chromium doesn't shift colours.
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                // Sharp text needs bits: about 12 Mbit/s at 1179x2556.
                AVVideoAverageBitRateKey: max(4_000_000, width * height * 4),
                AVVideoExpectedSourceFrameRateKey: 60,
                // Frequent keyframes keep scrubbing in the editor snappy.
                AVVideoMaxKeyFrameIntervalDurationKey: 1,
            ],
        ])
        video.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        guard writer.canAdd(video) else { throw writerError("The writer rejected the video track.") }
        writer.add(video)

        if let f = audioFormat {
            let channels = min(max(f.channels, 1), 2)
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: f.sampleRate,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: channels == 1 ? 96_000 : 160_000,
            ])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw writerError("The writer rejected the audio track.") }
            writer.add(input)
            audio = input
        } else {
            audio = nil
        }

        guard writer.startWriting() else {
            throw writer.error ?? writerError("Could not start writing \(url.lastPathComponent).")
        }
        writer.startSession(atSourceTime: startPTS)
    }

    var failure: Error? { writer.status == .failed ? (writer.error ?? writerError("The writer failed.")) : nil }

    /// Append one frame. Frames that don't move time forward, or that arrive
    /// while the encoder is busy, are dropped (the source is variable frame
    /// rate anyway). Returns whether the frame was written.
    @discardableResult
    func appendVideo(_ pixelBuffer: CVPixelBuffer, at pts: CMTime) -> Bool {
        guard pts.isValid, pts >= startPTS, !lastVideoPTS.isValid || pts > lastVideoPTS else { return false }
        guard writer.status == .writing, video.isReadyForMoreMediaData else { return false }
        var frame = pixelBuffer
        if CVPixelBufferGetWidth(frame) != width || CVPixelBufferGetHeight(frame) != height {
            guard let fitted = letterbox(frame) else { return false }
            frame = fitted
        }
        guard adaptor.append(frame, withPresentationTime: pts) else { return false }
        lastVideoPTS = pts
        return true
    }

    @discardableResult
    func appendAudio(_ sample: CMSampleBuffer) -> Bool {
        guard let audio, writer.status == .writing, audio.isReadyForMoreMediaData,
              CMSampleBufferGetPresentationTimeStamp(sample) >= startPTS else { return false }
        return audio.append(sample)
    }

    /// Scale a frame of another size (the phone rotated) to fit the take's
    /// size, centred on black.
    private func letterbox(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        if transfer == nil {
            var session: VTPixelTransferSession?
            VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &session)
            guard let session else { return nil }
            VTSessionSetProperty(session, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Letterbox)
            transfer = session
        }
        guard let transfer, let pool = adaptor.pixelBufferPool else { return nil }
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        guard let out, VTPixelTransferSessionTransferImage(transfer, from: source, to: out) == noErr else { return nil }
        return out
    }

    /// Close the file. The last frame is held until `end` (when the user
    /// pressed stop), so a static final screen isn't cut short.
    func finish(at end: CMTime, _ done: @escaping (Error?) -> Void) {
        guard writer.status == .writing else { return done(failure ?? writerError("The writer was not running.")) }
        if lastVideoPTS.isValid {
            writer.endSession(atSourceTime: end.isValid && end > lastVideoPTS ? end : lastVideoPTS)
        }
        video.markAsFinished()
        audio?.markAsFinished()
        writer.finishWriting { [writer] in
            done(writer.status == .completed ? nil : (writer.error ?? writerError("The movie could not be finished.")))
        }
    }

    func cancel() {
        if writer.status == .writing { writer.cancelWriting() }
        try? FileManager.default.removeItem(at: url)
    }

    deinit {
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
    }
}

/// The "finished" event, with the true size and length read back from the
/// file rather than trusted from the capture side.
func finishedEvent(_ url: URL) -> [String: Any] {
    var event: [String: Any] = ["event": "finished", "path": url.path]
    let asset = AVURLAsset(url: url)
    if let track = asset.tracks(withMediaType: .video).first {
        let size = track.naturalSize.applying(track.preferredTransform)
        event["width"] = Int(abs(size.width).rounded())
        event["height"] = Int(abs(size.height).rounded())
    }
    let seconds = CMTimeGetSeconds(asset.duration)
    if seconds.isFinite { event["duration"] = seconds }
    return event
}

// MARK: - recording

final class Recorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    static let firstFrameTimeout: TimeInterval = 3
    static let stallTimeout: TimeInterval = 5
    static let noFramesMessage = "No picture from your iPhone. Unlock it and keep the screen on. If you just tapped Trust, unplug and replug the cable. If that doesn't help, restart the iPhone."
    static let stalledMessage = "Your iPhone may be locked. Unlock it to keep recording."

    let session = AVCaptureSession()
    let videoOutput = AVCaptureVideoDataOutput()
    let audioOutput = AVCaptureAudioDataOutput()
    let device: AVCaptureDevice
    let url: URL
    /// Called exactly once, on the main queue, with the terminal event
    /// ("finished" or "error"), after the session has stopped.
    private let onEnd: ([String: Any]) -> Void

    // Sample callbacks, the watchdog, and every var below live on `queue`.
    private let queue = DispatchQueue(label: "ios-capture.samples")
    // startRunning/stopRunning block, so they get a queue of their own.
    private let sessionQueue = DispatchQueue(label: "ios-capture.session")
    private var writer: MovieWriter?
    private var hasAudio = false
    private var audioFormat: AudioFormat?
    private var runningSince: Date?
    private var lastNewFrameAt = Date()
    private var stalled = false
    private var watchdog: DispatchSourceTimer?
    private var stopping = false
    private var ended = false
    private var observers: [NSObjectProtocol] = []
    // For the one-line summary on stderr when the take ends.
    private var counts = (frames: 0, written: 0, letterboxed: 0, audio: 0, audioWritten: 0)
    private var firstAudioPTS = CMTime.invalid

    init(device: AVCaptureDevice, url: URL, onEnd: @escaping ([String: Any]) -> Void) {
        self.device = device
        self.url = url
        self.onEnd = onEnd
    }

    /// Call on the main queue.
    func start() {
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            let message = "Could not open \(device.localizedName): \(error.localizedDescription)"
            return queue.async { self.fail(message) }
        }
        session.beginConfiguration()
        var added = false
        if session.canAddInput(input) {
            session.addInput(input)
            // 4:2:0 video range is what the H.264 encoder takes natively.
            videoOutput.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            ]
            videoOutput.setSampleBufferDelegate(self, queue: queue)
            if session.canAddOutput(videoOutput) {
                session.addOutput(videoOutput)
                added = true
            }
            // The phone's own audio comes in on the same muxed input. A take
            // without it is still a take, so it's optional.
            if added && session.canAddOutput(audioOutput) {
                audioOutput.setSampleBufferDelegate(self, queue: queue)
                session.addOutput(audioOutput)
            }
        }
        session.commitConfiguration()
        guard added else { return queue.async { self.fail("The capture session rejected the device.") } }
        guard videoOutput.connection(with: .video) != nil else {
            return queue.async { self.fail("The device has no video stream.") }
        }
        let withAudio = audioOutput.connection(with: .audio) != nil

        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .AVCaptureSessionRuntimeError, object: session, queue: nil
        ) { [weak self] note in
            let err = note.userInfo?[AVCaptureSessionErrorKey] as? Error
            self?.queue.async { self?.endEarly("Capture failed: \(err?.localizedDescription ?? "unknown error")") }
        })
        // Cable pulled: keep what was recorded.
        observers.append(center.addObserver(
            forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil
        ) { [weak self] _ in
            self?.queue.async { self?.endEarly("The device disconnected.") }
        })

        try? FileManager.default.removeItem(at: url)
        queue.async { self.hasAudio = withAudio }
        sessionQueue.async {
            self.session.startRunning()
            self.queue.async { self.armWatchdog() }
        }
    }

    /// Finish the take. Safe from any queue, at any time, any number of
    /// times, and it never waits on the device: with no frames yet it ends
    /// straight away with an error.
    func stop() {
        queue.async { self.finishTake() }
    }

    // MARK: on `queue`

    private func armWatchdog() {
        guard !ended, !stopping else { return }
        runningSince = Date()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.checkFrames() }
        timer.resume()
        watchdog = timer
    }

    private func checkFrames() {
        guard !ended, !stopping, let since = runningSince else { return }
        if writer == nil {
            if Date().timeIntervalSince(since) >= Self.firstFrameTimeout {
                fail(Self.noFramesMessage, code: "no-frames")
            }
        } else if !stalled && Date().timeIntervalSince(lastNewFrameAt) > Self.stallTimeout {
            // A screen that simply isn't changing looks the same, so warn
            // rather than fail.
            stalled = true
            emit(["event": "warning", "code": "stalled", "message": Self.stalledMessage])
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !ended, !stopping else { return }
        if output === audioOutput { return handleAudio(sampleBuffer) }
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        counts.frames += 1

        if writer == nil {
            // The real size of what the phone is sending, not activeFormat.
            var width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels)
            if let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
                let d = CMVideoFormatDescriptionGetDimensions(format)
                if d.width > 0 && d.height > 0 { (width, height) = (Int(d.width), Int(d.height)) }
            }
            do {
                writer = try MovieWriter(url: url, width: width, height: height, startPTS: pts,
                                         audio: hasAudio ? (audioFormat ?? AudioFormat()) : nil)
            } catch {
                return fail("Could not start the recording: \(error.localizedDescription)")
            }
            lastNewFrameAt = Date()
            emit(["event": "started", "width": width, "height": height])
        }
        guard let writer else { return }
        if writer.appendVideo(pixels, at: pts) {
            counts.written += 1
            if CVPixelBufferGetWidth(pixels) != writer.width || CVPixelBufferGetHeight(pixels) != writer.height {
                counts.letterboxed += 1
            }
            lastNewFrameAt = Date()
            if stalled {
                stalled = false
                emit(["event": "warning", "code": "resumed"])
            }
        } else if let error = writer.failure {
            fail("Recording failed: \(error.localizedDescription)")
        }
    }

    private func handleAudio(_ sample: CMSampleBuffer) {
        counts.audio += 1
        if !firstAudioPTS.isValid { firstAudioPTS = CMSampleBufferGetPresentationTimeStamp(sample) }
        if let writer {
            if writer.appendAudio(sample) { counts.audioWritten += 1 }
            return
        }
        // Before the first frame, note the format so the AAC track matches
        // it (the writer is created on the first video frame).
        if audioFormat == nil, let format = CMSampleBufferGetFormatDescription(sample),
           let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
           asbd.mSampleRate > 0, asbd.mChannelsPerFrame > 0 {
            audioFormat = AudioFormat(sampleRate: asbd.mSampleRate, channels: Int(asbd.mChannelsPerFrame))
        }
    }

    /// Runtime error or disconnect: keep the footage if there is any.
    private func endEarly(_ message: String) {
        if writer != nil { finishTake() } else { fail(message) }
    }

    private func finishTake() {
        guard !ended, !stopping else { return }
        stopping = true
        guard let writer else { return fail("Stopped before your iPhone sent any video.") }
        // Hold the last frame until now. Measured on the wall clock, so it
        // doesn't matter which clock the device stamps its samples with.
        let held = CMTime(seconds: Date().timeIntervalSince(lastNewFrameAt), preferredTimescale: 600)
        let end = writer.lastVideoPTS.isValid ? CMTimeAdd(writer.lastVideoPTS, held) : .invalid
        writer.finish(at: end) { error in
            self.queue.async {
                if let error {
                    self.writer?.cancel()
                    self.end(["event": "error", "message": "Recording failed: \(error.localizedDescription)"])
                } else {
                    self.end(finishedEvent(self.url))
                }
            }
        }
    }

    private func fail(_ message: String, code: String? = nil) {
        writer?.cancel()
        var event: [String: Any] = ["event": "error", "message": message]
        if let code { event["code"] = code }
        end(event)
    }

    /// Tear down, and report only once the session has stopped so the next
    /// take can open the device straight away.
    private func end(_ event: [String: Any]) {
        guard !ended else { return }
        ended = true
        let c = counts
        let pts = { (t: CMTime) in t.isValid ? String(format: "%.3f", CMTimeGetSeconds(t)) : "none" }
        FileHandle.standardError.write(("ios-capture: frames \(c.frames) (written \(c.written), letterboxed \(c.letterboxed)), "
            + "audio buffers \(c.audio) (written \(c.audioWritten), track \(hasAudio ? "on" : "off")), "
            + "first video pts \(pts(writer?.startPTS ?? .invalid)), first audio pts \(pts(firstAudioPTS))\n").data(using: .utf8)!)
        watchdog?.cancel()
        watchdog = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        sessionQueue.async {
            if self.session.isRunning { self.session.stopRunning() }
            DispatchQueue.main.async { self.onEnd(event) }
        }
    }
}

/// Check permission, look the device up (it can take a few seconds to
/// appear after the opt-in), and start recording. `onEnd` gets the terminal
/// event, including every failure before recording began. Returns a stop
/// function.
func startRecording(id: String, path: String, onEnd: @escaping ([String: Any]) -> Void) -> (() -> Void) {
    var recorder: Recorder?
    var cancelled = false
    let deadline = Date().addingTimeInterval(5)
    func attempt() {
        if cancelled { return onEnd(["event": "error", "message": "Stopped before recording started."]) }
        guard let device = AVCaptureDevice(uniqueID: id) else {
            if Date() < deadline {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: attempt)
            } else {
                onEnd(["event": "error", "message": "Device \(id) not found. Is it connected, unlocked, and trusted?"])
            }
            return
        }
        let r = Recorder(device: device, url: URL(fileURLWithPath: path), onEnd: onEnd)
        recorder = r
        r.start()
    }
    checkCameraAccess { reason in
        if let reason { return onEnd(["event": "error", "message": reason]) }
        attempt()
    }
    return {
        if let recorder { recorder.stop() } else { cancelled = true }
    }
}

/// Read stdin lines on a background thread; deliver each on the main queue,
/// then nil at EOF.
func readStdinLines(_ handle: @escaping (String?) -> Void) {
    Thread.detachNewThread {
        while let line = readLine() {
            DispatchQueue.main.async { handle(line) }
        }
        DispatchQueue.main.async { handle(nil) }
    }
}

func onSignals(_ handler: @escaping () -> Void) -> [DispatchSourceSignal] {
    [SIGINT, SIGTERM].map { sig in
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler(handler: handler)
        src.resume()
        return src
    }
}

// MARK: - subcommands

func list(waitMs: Int) -> Never {
    allowScreenCaptureDevices()
    // Devices take 1-3s to appear after the opt-in. Return early once at
    // least one has shown up and nothing new has arrived for a moment.
    var lastChange = Date()
    let center = NotificationCenter.default
    let observers = [AVCaptureDevice.wasConnectedNotification, AVCaptureDevice.wasDisconnectedNotification]
        .map { center.addObserver(forName: $0, object: nil, queue: .main) { _ in lastChange = Date() } }
    pump(until: Date().addingTimeInterval(Double(waitMs) / 1000)) {
        !screenDevices().isEmpty && Date().timeIntervalSince(lastChange) > 0.5
    }
    observers.forEach(center.removeObserver)
    emit(describe(screenDevices()))
    exit(0)
}

func record(id: String, path: String) -> Never {
    allowScreenCaptureDevices()
    let stop = startRecording(id: id, path: path) { event in
        emit(event)
        exit(event["event"] as? String == "finished" ? 0 : 1)
    }
    let signals = onSignals(stop)
    readStdinLines { line in
        // "stop", or stdin closing (the parent went away), ends the take.
        if line == nil || line?.trimmingCharacters(in: .whitespaces) == "stop" { stop() }
    }
    withExtendedLifetime(signals) { RunLoop.main.run() }
    exit(0)
}

func serve() -> Never {
    allowScreenCaptureDevices()

    // Push the device list whenever it changes. Connect/disconnect
    // notifications trigger a check; a slow poll backs them up.
    var lastList = ""
    func publish() {
        let devices = describe(screenDevices())
        let key = String(describing: devices)
        guard key != lastList else { return }
        lastList = key
        emit(["event": "devices", "devices": devices])
    }
    publish()
    for name in [AVCaptureDevice.wasConnectedNotification, AVCaptureDevice.wasDisconnectedNotification] {
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in publish() }
    }
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in publish() }

    var stopCurrent: (() -> Void)?
    var exitWhenIdle = false
    let signals = onSignals {
        exitWhenIdle = true
        if let stopCurrent { stopCurrent() } else { exit(0) }
    }
    readStdinLines { line in
        guard let line else {
            // Parent went away: finalize any take, then quit.
            exitWhenIdle = true
            if let stopCurrent { stopCurrent() } else { exit(0) }
            return
        }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let cmd = (try? JSONSerialization.jsonObject(with: Data(trimmed.utf8))) as? [String: Any]
        switch cmd?["cmd"] as? String ?? trimmed {
        case "record":
            guard stopCurrent == nil else { return emitError("A recording is already running.") }
            guard let id = cmd?["id"] as? String, let path = cmd?["path"] as? String else {
                return emitError("record needs an id and a path.")
            }
            // onEnd can fire synchronously (e.g. permission denied), so
            // only keep the stop function if the take is still live.
            var ended = false
            let stop = startRecording(id: id, path: path) { event in
                ended = true
                stopCurrent = nil
                emit(event)
                if exitWhenIdle { exit(0) }
            }
            if !ended { stopCurrent = stop }
        case "stop":
            stopCurrent?()
        default:
            emitError("Unknown command: \(trimmed)")
        }
    }
    withExtendedLifetime(signals) { RunLoop.main.run() }
    exit(0)
}

/// Push a synthetic take through MovieWriter: 2s portrait, 1s landscape (a
/// rotation), 1s portrait, plus silent stereo audio. The size is odd on
/// purpose, as real phones' are (1179x2556). Frames are flat white, so any
/// letterbox bar that isn't black shows up in a brightness check.
func selftest(path: String) -> Never {
    let url = URL(fileURLWithPath: path)
    let (width, height, fps) = (393, 851, 30)
    let start = CMTime(value: 90_000, timescale: 30) // not zero, like a real clock

    func frame(_ w: Int, _ h: Int) -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &pb)
        let buffer = pb!
        CVPixelBufferLockBaseAddress(buffer, [])
        memset(CVPixelBufferGetBaseAddressOfPlane(buffer, 0), 235, CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) * h)
        memset(CVPixelBufferGetBaseAddressOfPlane(buffer, 1), 128, CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) * ((h + 1) / 2))
        CVPixelBufferUnlockBaseAddress(buffer, [])
        return buffer
    }

    var asbd = AudioStreamBasicDescription(
        mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2,
        mBitsPerChannel: 32, mReserved: 0)
    var audioFormat: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                   magicCookie: nil, extensions: nil, formatDescriptionOut: &audioFormat)
    func silence(at pts: CMTime, frames: Int) -> CMSampleBuffer {
        let bytes = frames * 8
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
                                           customBlockSource: nil, offsetToData: 0, dataLength: bytes,
                                           flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes)
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block!, formatDescription: audioFormat!, sampleCount: frames,
            presentationTimeStamp: pts, packetDescriptions: nil, sampleBufferOut: &sample)
        return sample!
    }

    do {
        let writer = try MovieWriter(url: url, width: width, height: height, startPTS: start, audio: AudioFormat())
        let portrait = frame(width, height), landscape = frame(height, width)
        for i in 0..<(4 * fps) {
            let pts = CMTimeAdd(start, CMTime(value: CMTimeValue(i), timescale: CMTimeScale(fps)))
            let source = (2 * fps..<3 * fps).contains(i) ? landscape : portrait
            // Real time paces a capture; here, wait for the encoder instead.
            var tries = 0
            while !writer.appendVideo(source, at: pts) {
                if let error = writer.failure { throw error }
                tries += 1
                if tries > 500 { throw writerError("Frame \(i) was never accepted.") }
                usleep(2_000)
            }
            writer.appendAudio(silence(at: pts, frames: 48_000 / fps))
        }
        let end = CMTimeAdd(start, CMTime(value: CMTimeValue(4 * fps), timescale: CMTimeScale(fps)))
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        writer.finish(at: end) { failure = $0; done.signal() }
        done.wait()
        if let failure { throw failure }
        emit(finishedEvent(url))
        exit(0)
    } catch {
        emitError("selftest failed: \(error.localizedDescription)")
        exit(1)
    }
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "list":
    var wait = 3000
    if let i = args.firstIndex(of: "--wait"), i + 1 < args.count, let ms = Int(args[i + 1]) {
        wait = max(0, ms)
    }
    list(waitMs: wait)
case "record" where args.count >= 3:
    record(id: args[1], path: args[2])
case "serve":
    serve()
case "selftest" where args.count >= 2:
    selftest(path: args[1])
default:
    FileHandle.standardError.write(
        "usage: ios-capture list [--wait ms] | record <uniqueID> <out.mov> | serve | selftest <out.mov>\n".data(using: .utf8)!)
    exit(2)
}
