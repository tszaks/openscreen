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
//   ios-capture serve [--preview-fd 3]    long-lived; what the app uses
//   ios-capture selftest <out> [--seconds 4] [--realtime] [--audio silent|late|none]
//                                         write a synthetic take (with a
//                                         mid-take rotation) through the
//                                         same writer; needs no device.
//                                         --realtime paces it like a capture
//   ios-capture selftest-preview [--seconds 2] [--fd 3]
//                                         synthetic preview frames on fd 3
//
// The opt-in blocks for up to ~5s in every new process, so the app keeps one
// `serve` process alive rather than paying that per poll or per recording.
//
// stdout is one JSON object per line:
//   {"event":"devices","devices":[{"id","name","modelID","manufacturer"}]}
//   {"event":"started","width":..,"height":..,"startedAtMs":..}
//       sent on a take's first video frame, with that frame's real size and
//       the epoch time it was captured (the movie's t=0), so a Mac take
//       recorded alongside can be lined up with it
//   {"event":"finished","path":..,"width":..,"height":..,"duration":..}
//   {"event":"error","message":..,"code":..}
//       "code" is optional. "no-frames": no picture arrived within 3s
//       (phone locked, trust revoked, "Stop Mirroring" tapped). The take
//       ends and no file is left behind.
//   {"event":"warning","code":"stalled","message":..}
//       no new frame for 5s, or the same picture for 8s, mid-take. A locked
//       phone keeps repeating its last frame (~53 fps measured), so it's
//       the picture check that usually catches it; a screen that simply
//       isn't changing trips it too, so it's only a warning. Recording
//       carries on; sent once per stall.
//   {"event":"warning","code":"resumed"}
//       frames are arriving again after "stalled".
//   {"event":"preview","id":..,"state":"connecting"|"live"|"stopped"|"error",
//    "width":..,"height":..,"message":..,"code":..}
//       the live preview's state. "live" carries the first frame's size;
//       "error" a message, and code "no-frames" when no picture came in 3s.
// serve reads one command per line on stdin:
//   {"cmd":"preview","id":"<uniqueID>","fps":12,"maxEdge":360,"quality":0.6}
//       open the device for a live preview (fps/maxEdge/quality optional)
//   {"cmd":"unpreview"}  close it; during a take, once the take ends
//   {"cmd":"record","id":"<uniqueID>","path":"/abs/out.mov"}
//       reuses a running preview session on that device, so writing starts
//       at the next frame; the session stays up afterwards if the preview
//       is still on
//   {"cmd":"stop"}      (a bare "stop" line also works)
// SIGINT, SIGTERM or EOF on stdin finish any take, then exit.
//
// Preview frames go to --preview-fd (the app passes fd 3), never stdout:
// each is a 4-byte big-endian length and a JPEG about 360 px on its long
// edge, at most ~12 a second, dropped rather than queued if the app is slow.
//
// Takes are fragmented movies (a fragment every 2s), so a take whose writer
// never finished (crash, SIGKILL) still plays up to its last fragment.
//
// Why not AVCaptureMovieFileOutput: on an iOS-device session it washes the
// picture out (gamma, FB22281424), and rotating the phone mid-take ends the
// recording and saves nothing (FB21253500). Decoded frames go through
// AVAssetWriter instead, as H.264 High + AAC, tagged Rec.709.
//
// Audio: the phone sends no audio buffers at all while nothing plays
// (measured: 0 buffers over a 6s take). Whenever the phone's audio is
// missing or more than half a second behind the video, silence is written
// in its place, so every file has a full-length stereo AAC track (what App
// Store previews expect) and the writer keeps flushing movie fragments: a
// track with no samples makes it hold everything back to interleave.
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
import CoreImage
import CoreMediaIO
import Foundation
import ImageIO
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

/// The one audio layout the writer takes: the capture output is set to
/// deliver it (AVCaptureAudioDataOutput.audioSettings), and silence is
/// written in it. The AAC encoder can't cope with its input layout
/// changing mid-take, so real audio and silence must match.
struct AudioFormat {
    var sampleRate: Double = 48_000
    var channels = 2

    var asbd: AudioStreamBasicDescription {
        let bytesPerFrame = UInt32(4 * channels)
        return AudioStreamBasicDescription(
            mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: bytesPerFrame, mFramesPerPacket: 1, mBytesPerFrame: bytesPerFrame,
            mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
    }

    /// For AVCaptureAudioDataOutput.audioSettings.
    var captureSettings: [String: Any] {
        [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: channels,
         AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
         AVLinearPCMIsBigEndianKey: false]
    }

    /// Whether a sample is in this layout.
    func matches(_ sample: CMSampleBuffer) -> Bool {
        guard let format = CMSampleBufferGetFormatDescription(sample),
              let got = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { return false }
        let want = asbd
        return got.mFormatID == want.mFormatID && got.mSampleRate == want.mSampleRate
            && got.mChannelsPerFrame == want.mChannelsPerFrame && got.mBitsPerChannel == want.mBitsPerChannel
            && got.mFormatFlags & (kAudioFormatFlagIsFloat | kAudioFormatFlagIsNonInterleaved) == kAudioFormatFlagIsFloat
    }
}

func writerError(_ message: String) -> Error {
    NSError(domain: "ios-capture", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// `frames` of `format` LPCM at `pts`, silent, or filled by `fill` with
/// interleaved float samples.
func pcmAudio(_ format: AudioFormat, at pts: CMTime, frames: Int, fill: ((UnsafeMutableBufferPointer<Float>) -> Void)? = nil) -> CMSampleBuffer? {
    var asbd = format.asbd
    var description: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                   magicCookie: nil, extensions: nil, formatDescriptionOut: &description)
    let count = frames * format.channels
    let bytes = count * 4
    var block: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
                                       customBlockSource: nil, offsetToData: 0, dataLength: bytes,
                                       flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
    guard let description, let block else { return nil }
    var values = [Float](repeating: 0, count: count)
    if let fill { values.withUnsafeMutableBufferPointer { fill($0) } }
    values.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) }
    var sample: CMSampleBuffer?
    CMAudioSampleBufferCreateReadyWithPacketDescriptions(
        allocator: nil, dataBuffer: block, formatDescription: description, sampleCount: frames,
        presentationTimeStamp: pts, packetDescriptions: nil, sampleBufferOut: &sample)
    return sample
}

/// A cheap fingerprint of a frame: its luma on a 32x64 grid. Used to spot a
/// frozen picture, since a locked phone keeps sending the same frame.
enum LumaGrid {
    static let columns = 32, rows = 64

    static func sample(_ pixels: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        let planar = CVPixelBufferIsPlanar(pixels)
        guard let base = planar ? CVPixelBufferGetBaseAddressOfPlane(pixels, 0) : CVPixelBufferGetBaseAddress(pixels)
        else { return [] }
        let width = planar ? CVPixelBufferGetWidthOfPlane(pixels, 0) : CVPixelBufferGetWidth(pixels)
        let height = planar ? CVPixelBufferGetHeightOfPlane(pixels, 0) : CVPixelBufferGetHeight(pixels)
        let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(pixels, 0) : CVPixelBufferGetBytesPerRow(pixels)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var grid = [UInt8]()
        grid.reserveCapacity(columns * rows)
        for r in 0..<rows {
            let y = (2 * r + 1) * height / (2 * rows)
            for c in 0..<columns {
                grid.append(bytes[y * stride + (2 * c + 1) * width / (2 * columns)])
            }
        }
        return grid
    }

    /// Changed if any point moved by more than a little: decoding noise
    /// shifts values by a level or two, real content by far more.
    static func differ(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        a.count != b.count || zip(a, b).contains { abs(Int($0) - Int($1)) > 6 }
    }
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
    private let audioFormat: AudioFormat
    /// Where the audio track has got to (real audio or silence).
    private var audioEnd = CMTime.invalid
    let startPTS: CMTime
    private var transfer: VTPixelTransferSession?
    private(set) var lastVideoPTS = CMTime.invalid

    /// False only for the selftest, which feeds frames faster than real
    /// time and so has to wait for the encoder.
    private let realtime: Bool

    init(url: URL, width: Int, height: Int, startPTS: CMTime, audio audioFormat: AudioFormat?, realtime: Bool = true) throws {
        self.url = url
        self.realtime = realtime
        self.width = width
        self.height = height
        self.startPTS = startPTS
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(url: url, fileType: url.pathExtension.lowercased() == "mp4" ? .mp4 : .mov)
        // Fragmented: a movie fragment every 2s, so a take cut off by a
        // crash, a kill or a power cut still plays up to its last fragment.
        writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)

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

        self.audioFormat = audioFormat ?? AudioFormat()
        if audioFormat != nil {
            let channels = self.audioFormat.channels
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: self.audioFormat.sampleRate,
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
        keepAudioAlive(upTo: pts)
        return true
    }

    /// Append the phone's audio. A buffer that starts before where the
    /// track has got to (silence was written there while none came) is
    /// dropped, so nothing overlaps.
    @discardableResult
    func appendAudio(_ sample: CMSampleBuffer) -> Bool {
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        guard let audio, writer.status == .writing, audio.isReadyForMoreMediaData, pts >= startPTS,
              audioFormat.matches(sample) else { return false }
        if audioEnd.isValid && CMTimeGetSeconds(CMTimeSubtract(audioEnd, pts)) > 0.001 { return false }
        // Close any gap first, so the track has no holes.
        padSilence(until: pts, wait: !realtime)
        guard audio.isReadyForMoreMediaData, audio.append(sample) else { return false }
        let frames = CMSampleBufferGetNumSamples(sample)
        audioEnd = CMTimeAdd(pts, CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(audioFormat.sampleRate)))
        return true
    }

    /// A track that gets no samples stops the writer from flushing movie
    /// fragments (it waits to interleave), which would leave nothing
    /// playable after a crash and keep the whole take in memory. The phone
    /// sends no audio while nothing plays, so whenever the audio is more
    /// than half a second behind the video, fill the gap with silence.
    private func keepAudioAlive(upTo pts: CMTime) {
        guard audio != nil else { return }
        let from = audioEnd.isValid ? audioEnd : startPTS
        guard CMTimeGetSeconds(CMTimeSubtract(pts, from)) > 0.5 else { return }
        padSilence(until: pts, wait: !realtime)
    }

    /// Fill the audio track with silence from where it has got to until
    /// `end`. `wait`: not real time (finishing), so wait for the encoder.
    private func padSilence(until end: CMTime, wait: Bool) {
        guard let audio else { return }
        let rate = Int(audioFormat.sampleRate)
        var at = audioEnd.isValid ? audioEnd : startPTS
        var remaining = Int((CMTimeGetSeconds(CMTimeSubtract(end, at)) * Double(rate)).rounded(.down))
        while remaining > 0 {
            let frames = min(rate, remaining)
            guard let sample = pcmAudio(audioFormat, at: at, frames: frames) else { return }
            var waited = 0
            while wait && !audio.isReadyForMoreMediaData && waited < 2_000 && writer.status == .writing {
                usleep(1_000)
                waited += 1
            }
            guard audio.isReadyForMoreMediaData, audio.append(sample) else { return }
            at = CMTimeAdd(at, CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(rate)))
            audioEnd = at
            remaining -= frames
        }
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
            let sessionEnd = end.isValid && end > lastVideoPTS ? end : lastVideoPTS
            // Silence to the end, so the audio track runs the full length.
            padSilence(until: sessionEnd, wait: true)
            writer.endSession(atSourceTime: sessionEnd)
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

// MARK: - preview frames

/// Small JPEG frames for the app's live preview, written to a pipe (fd 3 in
/// serve mode) as a 4-byte big-endian length followed by the JPEG bytes.
///
/// The capture queue only hands a frame over. Scaling, encoding and the
/// write happen on this sink's own queue, and a frame offered while that
/// queue is still busy (or too soon after the last one) is dropped, so the
/// newest frame always wins and the writer path never waits. The write
/// blocks only this queue: if the app stops reading, frames are dropped
/// upstream. (A non-blocking write could stop half way through a frame and
/// break the framing.)
final class PreviewSink {
    private let fd: Int32
    private let queue = DispatchQueue(label: "ios-capture.preview", qos: .utility)
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let lock = NSLock()
    // Under `lock`.
    private var busy = false
    private var dead = false
    private var lastAt: CFAbsoluteTime = 0
    private var interval: CFAbsoluteTime = 0.08
    private var maxEdge: CGFloat = 360
    private var quality: Double = 0.6
    /// Frames written; read after drain().
    private(set) var sent = 0

    private init(fd: Int32) { self.fd = fd }

    /// A sink on `fd` if it is a pipe or socket; nil otherwise, so a stray
    /// inherited fd 3 (some other file) is never written into.
    static func open(fd: Int32) -> PreviewSink? {
        var st = stat()
        guard fstat(fd, &st) == 0 else { return nil }
        let type = st.st_mode & S_IFMT
        guard type == S_IFIFO || type == S_IFSOCK else { return nil }
        let flags = fcntl(fd, F_GETFL)
        if flags >= 0 { _ = fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) }
        return PreviewSink(fd: fd)
    }

    func configure(fps: Double?, maxEdge: Double?, quality: Double?) {
        lock.lock()
        defer { lock.unlock() }
        if let fps, fps > 0 { interval = 1 / min(fps, 60) }
        if let maxEdge, maxEdge >= 64 { self.maxEdge = CGFloat(min(maxEdge, 1600)) }
        if let quality, quality > 0, quality <= 1 { self.quality = quality }
    }

    /// Take a frame if the sink is free and it's time for one. Never blocks.
    @discardableResult
    func offer(_ pixels: CVPixelBuffer) -> Bool {
        let now = CFAbsoluteTimeGetCurrent()
        lock.lock()
        guard !dead, !busy, now - lastAt >= interval else {
            lock.unlock()
            return false
        }
        busy = true
        lastAt = now
        let (edge, q) = (maxEdge, quality)
        lock.unlock()
        queue.async {
            if let jpeg = self.encode(pixels, maxEdge: edge, quality: q) { self.write(jpeg) }
            self.lock.lock()
            self.busy = false
            self.lock.unlock()
        }
        return true
    }

    /// Wait for the frame in flight, if any.
    func drain() { queue.sync {} }

    private func encode(_ pixels: CVPixelBuffer, maxEdge: CGFloat, quality: Double) -> Data? {
        let image = CIImage(cvPixelBuffer: pixels)
        let longEdge = max(image.extent.width, image.extent.height)
        guard longEdge > 0, let srgb = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let scale = min(1, maxEdge / longEdge)
        var scaled = image
        if scale < 1 {
            // Lanczos keeps small UI text legible at thumbnail size.
            scaled = image.applyingFilter("CILanczosScaleTransform", parameters: [
                kCIInputScaleKey: scale, kCIInputAspectRatioKey: 1,
            ])
            let w = (image.extent.width * scale).rounded(.down), h = (image.extent.height * scale).rounded(.down)
            scaled = scaled.cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
        }
        let key = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return context.jpegRepresentation(of: scaled, colorSpace: srgb, options: [key: quality])
    }

    private func write(_ jpeg: Data) {
        var frame = Data(count: 4)
        let n = UInt32(jpeg.count)
        frame[0] = UInt8(n >> 24 & 0xFF)
        frame[1] = UInt8(n >> 16 & 0xFF)
        frame[2] = UInt8(n >> 8 & 0xFF)
        frame[3] = UInt8(n & 0xFF)
        frame.append(jpeg)
        let ok = frame.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.baseAddress else { return false }
            var offset = 0
            while offset < raw.count {
                let wrote = Darwin.write(fd, base + offset, raw.count - offset)
                if wrote > 0 {
                    offset += wrote
                } else if wrote < 0 && (errno == EINTR || errno == EAGAIN) {
                    if errno == EAGAIN { usleep(2_000) }
                } else {
                    return false
                }
            }
            return true
        }
        if ok {
            sent += 1
        } else {
            // The reader went away (EPIPE): stop encoding frames nobody reads.
            lock.lock()
            dead = true
            lock.unlock()
        }
    }
}

// MARK: - capture

/// One recording on a Capture. Lives on the capture's queue.
final class Take {
    let url: URL
    let onEnd: ([String: Any]) -> Void
    let attachedAt = Date()
    var writer: MovieWriter?
    var stopping = false
    var lastNewFrameAt = Date()
    var lastGrid: [UInt8] = []
    var lastGridAt = Date.distantPast
    var lastPictureChangeAt = Date()
    var stalled = false
    // For the one-line summary on stderr when the take ends.
    var counts = (frames: 0, written: 0, letterboxed: 0, audio: 0, audioWritten: 0)
    var firstAudioPTS = CMTime.invalid

    init(url: URL, onEnd: @escaping ([String: Any]) -> Void) {
        self.url = url
        self.onEnd = onEnd
    }
}

// startRunning/stopRunning block, so they get a queue of their own. It is
// shared by every Capture, so a new session on a device only opens once
// the previous one on it has stopped.
let sessionQueue = DispatchQueue(label: "ios-capture.session")

/// One capture session on one device. It runs for a live preview, a take,
/// or both: a take started while the preview runs reuses the session and
/// begins writing at the next frame, so there is never a second session on
/// the phone and recording starts at once. When the take ends the session
/// keeps running if the preview is still wanted, and closes otherwise.
final class Capture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    static let firstFrameTimeout: TimeInterval = 3
    static let stallTimeout: TimeInterval = 5
    static let frozenTimeout: TimeInterval = 8
    static let noFramesMessage = "No picture from your iPhone. Unlock it and keep the screen on. If you just tapped Trust, unplug and replug the cable. If that doesn't help, restart the iPhone."
    static let stalledMessage = "Your iPhone may be locked. Unlock it to keep recording."

    let deviceID: String
    let session = AVCaptureSession()
    let videoOutput = AVCaptureVideoDataOutput()
    let audioOutput = AVCaptureAudioDataOutput()
    private let sink: PreviewSink?
    /// Called once on the main queue after the session has stopped.
    var onClosed: (() -> Void)?

    // Sample callbacks, the watchdog, and every var below live on `queue`.
    private let queue = DispatchQueue(label: "ios-capture.samples")
    private var wantsPreview = false
    private var take: Take?
    private var hasAudio = false
    private var runningSince: Date?
    private var liveSize: (width: Int, height: Int)?
    private var watchdog: DispatchSourceTimer?
    private var closeAfterTake = false
    private var observers: [NSObjectProtocol] = [] // main queue

    private let closedLock = NSLock()
    private var closedFlag = false
    /// Once closed, a Capture never runs again. Readable from any queue.
    var isClosed: Bool {
        closedLock.lock()
        defer { closedLock.unlock() }
        return closedFlag
    }

    init(deviceID: String, sink: PreviewSink?) {
        self.deviceID = deviceID
        self.sink = sink
    }

    // MARK: control (any queue)

    /// Check permission, look the device up (it can take a few seconds to
    /// appear after the opt-in), and start the session. Call on main.
    func start() {
        checkCameraAccess { reason in
            if let reason { return self.queue.async { self.failAll(reason) } }
            self.lookUp(deadline: Date().addingTimeInterval(5))
        }
    }

    /// Turn the preview on or off. Off with no take closes the session; off
    /// during a take waits for the take to end.
    func setPreview(_ on: Bool) {
        queue.async {
            guard !self.isClosed else { return }
            self.wantsPreview = on
            if on {
                if let size = self.liveSize {
                    self.emitPreview("live", ["width": size.width, "height": size.height])
                } else {
                    self.emitPreview("connecting")
                }
            } else if self.take == nil {
                self.close()
            }
        }
    }

    /// Start a take; writing begins at the next frame. `onEnd` gets the
    /// terminal event ("finished" or "error") exactly once, on main.
    func record(to url: URL, onEnd: @escaping ([String: Any]) -> Void) {
        queue.async {
            if self.isClosed {
                return DispatchQueue.main.async { onEnd(["event": "error", "message": "The capture closed before recording started."]) }
            }
            guard self.take == nil else {
                return DispatchQueue.main.async { onEnd(["event": "error", "message": "A recording is already running."]) }
            }
            try? FileManager.default.removeItem(at: url)
            self.take = Take(url: url, onEnd: onEnd)
        }
    }

    /// Finish the take. Safe at any time, any number of times, and it never
    /// waits on the device: with no frames yet it ends straight away with
    /// an error.
    func stopTake() {
        queue.async { self.finishTake() }
    }

    // MARK: opening (main queue)

    private func lookUp(deadline: Date) {
        guard !isClosed else { return }
        guard let device = AVCaptureDevice(uniqueID: deviceID) else {
            if Date() < deadline {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.lookUp(deadline: deadline) }
            } else {
                let message = "Device \(deviceID) not found. Is it connected, unlocked, and trusted?"
                queue.async { self.failAll(message) }
            }
            return
        }
        open(device)
    }

    private func open(_ device: AVCaptureDevice) {
        guard !isClosed else { return }
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            let message = "Could not open \(device.localizedName): \(error.localizedDescription)"
            return queue.async { self.failAll(message) }
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
                audioOutput.audioSettings = AudioFormat().captureSettings
                audioOutput.setSampleBufferDelegate(self, queue: queue)
                session.addOutput(audioOutput)
            }
        }
        session.commitConfiguration()
        guard added else { return queue.async { self.failAll("The capture session rejected the device.") } }
        guard videoOutput.connection(with: .video) != nil else {
            return queue.async { self.failAll("The device has no video stream.") }
        }
        let withAudio = audioOutput.connection(with: .audio) != nil

        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .AVCaptureSessionRuntimeError, object: session, queue: nil
        ) { [weak self] note in
            let err = note.userInfo?[AVCaptureSessionErrorKey] as? Error
            self?.queue.async { self?.lost("Capture failed: \(err?.localizedDescription ?? "unknown error")") }
        })
        // Cable pulled: keep what was recorded.
        observers.append(center.addObserver(
            forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil
        ) { [weak self] _ in
            self?.queue.async { self?.lost("The device disconnected.") }
        })

        queue.async { self.hasAudio = withAudio }
        sessionQueue.async {
            guard !self.isClosed else { return }
            self.session.startRunning()
            self.queue.async { self.armWatchdog() }
        }
    }

    // MARK: on `queue`

    private func emitPreview(_ state: String, _ extra: [String: Any] = [:]) {
        var event: [String: Any] = ["event": "preview", "state": state, "id": deviceID]
        for (k, v) in extra { event[k] = v }
        emit(event)
    }

    private func armWatchdog() {
        guard !isClosed else { return }
        runningSince = Date()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.checkFrames() }
        timer.resume()
        watchdog = timer
    }

    private func checkFrames() {
        guard !isClosed, let since = runningSince else { return }
        let now = Date()
        // No picture at all: applies to a preview and a take alike.
        guard liveSize != nil else {
            if now.timeIntervalSince(since) >= Self.firstFrameTimeout {
                failAll(Self.noFramesMessage, code: "no-frames")
            }
            return
        }
        guard let take, !take.stopping else { return }
        guard take.writer != nil else {
            // The session had frames, but none since this take began.
            if now.timeIntervalSince(take.attachedAt) >= Self.firstFrameTimeout {
                failTake(Self.noFramesMessage, code: "no-frames")
            }
            return
        }
        // A screen that simply isn't changing looks the same as a locked
        // phone, so warn rather than fail.
        let stuck = now.timeIntervalSince(take.lastNewFrameAt) > Self.stallTimeout
            || now.timeIntervalSince(take.lastPictureChangeAt) > Self.frozenTimeout
        if stuck != take.stalled {
            take.stalled = stuck
            emit(stuck ? ["event": "warning", "code": "stalled", "message": Self.stalledMessage]
                       : ["event": "warning", "code": "resumed"])
        }
    }

    /// Epoch ms a frame was captured. Its timestamp is on the host clock, so
    /// its age is host-now minus it; an age that isn't a fraction of a second
    /// means some other clock, and "now" is the honest answer.
    static func captureEpochMs(_ pts: CMTime) -> Double {
        let now = Date().timeIntervalSince1970 * 1000
        let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts))
        guard age.isFinite, age >= 0, age < 1 else { return now.rounded() }
        return (now - age * 1000).rounded()
    }

    /// The real size of what the phone is sending, not activeFormat.
    private func frameSize(_ sampleBuffer: CMSampleBuffer, _ pixels: CVPixelBuffer) -> (width: Int, height: Int) {
        if let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            let d = CMVideoFormatDescriptionGetDimensions(format)
            if d.width > 0 && d.height > 0 { return (Int(d.width), Int(d.height)) }
        }
        return (CVPixelBufferGetWidth(pixels), CVPixelBufferGetHeight(pixels))
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !isClosed else { return }
        if output === audioOutput { return handleAudio(sampleBuffer) }
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        if liveSize == nil {
            let size = frameSize(sampleBuffer, pixels)
            liveSize = size
            if wantsPreview { emitPreview("live", ["width": size.width, "height": size.height]) }
        }
        // Hands the frame over (or drops it); never waits.
        sink?.offer(pixels)

        guard let take, !take.stopping else { return }
        take.counts.frames += 1
        if take.writer == nil {
            let (width, height) = frameSize(sampleBuffer, pixels)
            do {
                take.writer = try MovieWriter(url: take.url, width: width, height: height, startPTS: pts,
                                              audio: hasAudio ? AudioFormat() : nil)
            } catch {
                return failTake("Could not start the recording: \(error.localizedDescription)")
            }
            take.lastNewFrameAt = Date()
            take.lastPictureChangeAt = Date()
            emit(["event": "started", "width": width, "height": height, "startedAtMs": Self.captureEpochMs(pts)])
        }
        guard let writer = take.writer else { return }
        if writer.appendVideo(pixels, at: pts) {
            take.counts.written += 1
            if CVPixelBufferGetWidth(pixels) != writer.width || CVPixelBufferGetHeight(pixels) != writer.height {
                take.counts.letterboxed += 1
            }
            take.lastNewFrameAt = Date()
            // Fingerprint the picture twice a second, not every frame.
            if take.lastNewFrameAt.timeIntervalSince(take.lastGridAt) >= 0.5 {
                take.lastGridAt = take.lastNewFrameAt
                let grid = LumaGrid.sample(pixels)
                if LumaGrid.differ(grid, take.lastGrid) { take.lastPictureChangeAt = take.lastNewFrameAt }
                take.lastGrid = grid
            }
        } else if let error = writer.failure {
            failTake("Recording failed: \(error.localizedDescription)")
        }
    }

    private func handleAudio(_ sample: CMSampleBuffer) {
        guard let take, !take.stopping else { return }
        take.counts.audio += 1
        if !take.firstAudioPTS.isValid { take.firstAudioPTS = CMSampleBufferGetPresentationTimeStamp(sample) }
        if let writer = take.writer, writer.appendAudio(sample) { take.counts.audioWritten += 1 }
    }

    private func finishTake() {
        guard let take, !take.stopping else { return }
        take.stopping = true
        guard let writer = take.writer else { return failTake("Stopped before your iPhone sent any video.") }
        // Hold the last frame until now. Measured on the wall clock, so it
        // doesn't matter which clock the device stamps its samples with.
        let held = CMTime(seconds: Date().timeIntervalSince(take.lastNewFrameAt), preferredTimescale: 600)
        let end = writer.lastVideoPTS.isValid ? CMTimeAdd(writer.lastVideoPTS, held) : .invalid
        writer.finish(at: end) { error in
            self.queue.async {
                // A file that failed to finish is left in place: its movie
                // fragments may still play, and the app decides.
                self.endTake(error.map { ["event": "error", "message": "Recording failed: \($0.localizedDescription)"] }
                             ?? finishedEvent(take.url))
            }
        }
    }

    private func failTake(_ message: String, code: String? = nil) {
        guard let take else { return }
        // Keep a file that has frames in it (its fragments may play);
        // remove one that never got a picture.
        if let writer = take.writer {
            if !writer.lastVideoPTS.isValid { writer.cancel() }
        } else {
            try? FileManager.default.removeItem(at: take.url)
        }
        var event: [String: Any] = ["event": "error", "message": message]
        if let code { event["code"] = code }
        endTake(event)
    }

    private func endTake(_ event: [String: Any]) {
        guard let take else { return }
        self.take = nil
        let c = take.counts
        let pts = { (t: CMTime) in t.isValid ? String(format: "%.3f", CMTimeGetSeconds(t)) : "none" }
        FileHandle.standardError.write(("ios-capture: frames \(c.frames) (written \(c.written), letterboxed \(c.letterboxed)), "
            + "audio buffers \(c.audio) (written \(c.audioWritten), track \(hasAudio ? "on" : "off")), "
            + "first video pts \(pts(take.writer?.startPTS ?? .invalid)), first audio pts \(pts(take.firstAudioPTS))\n").data(using: .utf8)!)
        if wantsPreview && !closeAfterTake {
            DispatchQueue.main.async { take.onEnd(event) }
        } else {
            // Report only once the session has stopped, so the next take
            // can open the device straight away.
            close { take.onEnd(event) }
        }
    }

    /// The session can't run (no permission, no device, no picture): fail
    /// the preview and any take, and close.
    private func failAll(_ message: String, code: String? = nil) {
        guard !isClosed else { return }
        if wantsPreview {
            var extra: [String: Any] = ["message": message]
            if let code { extra["code"] = code }
            emitPreview("error", extra)
            wantsPreview = false
        }
        if take != nil {
            closeAfterTake = true
            failTake(message, code: code)
        } else {
            close()
        }
    }

    /// Runtime error or disconnect: keep the take's footage if there is any.
    private func lost(_ message: String) {
        guard !isClosed else { return }
        if wantsPreview {
            emitPreview("error", ["message": message])
            wantsPreview = false
        }
        closeAfterTake = true
        if let take {
            if take.writer != nil { finishTake() } else { failTake(message) }
        } else {
            close()
        }
    }

    private func close(then done: (() -> Void)? = nil) {
        closedLock.lock()
        let already = closedFlag
        closedFlag = true
        closedLock.unlock()
        if already {
            if let done { DispatchQueue.main.async(execute: done) }
            return
        }
        if wantsPreview { emitPreview("stopped") }
        wantsPreview = false
        watchdog?.cancel()
        watchdog = nil
        sessionQueue.async {
            if self.session.isRunning { self.session.stopRunning() }
            DispatchQueue.main.async {
                self.observers.forEach(NotificationCenter.default.removeObserver)
                self.observers = []
                done?()
                self.onClosed?()
                self.onClosed = nil
            }
        }
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
    let capture = Capture(deviceID: id, sink: nil)
    capture.record(to: URL(fileURLWithPath: path)) { event in
        emit(event)
        exit(event["event"] as? String == "finished" ? 0 : 1)
    }
    capture.start()
    let signals = onSignals { capture.stopTake() }
    readStdinLines { line in
        // "stop", or stdin closing (the parent went away), ends the take.
        if line == nil || line?.trimmingCharacters(in: .whitespaces) == "stop" { capture.stopTake() }
    }
    withExtendedLifetime(signals) { RunLoop.main.run() }
    exit(0)
}

func serve(previewFD: Int32?) -> Never {
    allowScreenCaptureDevices()
    let sink = previewFD.flatMap { PreviewSink.open(fd: $0) }
    if let previewFD, sink == nil {
        FileHandle.standardError.write("ios-capture: fd \(previewFD) is not a pipe; no preview frames\n".data(using: .utf8)!)
    }

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

    // At most one Capture (one device) at a time; everything here is on main.
    var capture: Capture?
    var recording = false
    var exitWhenIdle = false
    func current() -> Capture? { capture.flatMap { $0.isClosed ? nil : $0 } }
    func makeCapture(_ id: String) -> Capture {
        let c = Capture(deviceID: id, sink: sink)
        c.onClosed = { [weak c] in if capture === c { capture = nil } }
        capture = c
        return c
    }

    // SIGTERM/SIGINT or stdin EOF: finalize any take, then quit. The file is
    // fragmented, so even a finish that never completes leaves it playable.
    func quit() {
        exitWhenIdle = true
        guard recording else { exit(0) }
        capture?.stopTake()
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { exit(0) }
    }
    let signals = onSignals(quit)
    readStdinLines { line in
        guard let line else { return quit() }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let cmd = (try? JSONSerialization.jsonObject(with: Data(trimmed.utf8))) as? [String: Any]
        switch cmd?["cmd"] as? String ?? trimmed {
        case "preview":
            guard let id = cmd?["id"] as? String else { return emitError("preview needs an id.") }
            sink?.configure(fps: cmd?["fps"] as? Double, maxEdge: cmd?["maxEdge"] as? Double,
                            quality: cmd?["quality"] as? Double)
            if let c = current() {
                if c.deviceID == id { return c.setPreview(true) }
                if recording {
                    return emit(["event": "preview", "state": "error", "id": id,
                                 "message": "A recording from another device is running."])
                }
                c.setPreview(false) // no take, so this closes it
            }
            let c = makeCapture(id)
            c.setPreview(true)
            c.start()
        case "unpreview":
            // During a take this only takes effect once the take ends.
            current()?.setPreview(false)
        case "record":
            guard !recording else { return emitError("A recording is already running.") }
            guard let id = cmd?["id"] as? String, let path = cmd?["path"] as? String else {
                return emitError("record needs an id and a path.")
            }
            var reuse = current()
            if let c = reuse, c.deviceID != id {
                c.setPreview(false)
                reuse = nil
            }
            let c = reuse ?? makeCapture(id)
            recording = true
            c.record(to: URL(fileURLWithPath: path)) { event in
                recording = false
                emit(event)
                if exitWhenIdle { exit(0) }
            }
            if reuse == nil { c.start() }
        case "stop":
            if recording { capture?.stopTake() }
        default:
            emitError("Unknown command: \(trimmed)")
        }
    }
    withExtendedLifetime(signals) { RunLoop.main.run() }
    exit(0)
}

/// A 4:2:0 frame of one flat luma (the selftest's picture).
func flatFrame(_ w: Int, _ h: Int, luma: Int32 = 235) -> CVPixelBuffer {
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                        [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &pb)
    let buffer = pb!
    CVPixelBufferLockBaseAddress(buffer, [])
    memset(CVPixelBufferGetBaseAddressOfPlane(buffer, 0), luma, CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) * h)
    memset(CVPixelBufferGetBaseAddressOfPlane(buffer, 1), 128, CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) * ((h + 1) / 2))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
}

/// Push a synthetic take through MovieWriter: portrait, a landscape stretch
/// (a rotation) from half way to three quarters, then portrait. `audio`:
/// "silent" (default) sends none, like a silent phone, so the silence
/// padding runs; "late" sends a tone during the landscape stretch only,
/// so silence goes before and after it; "none" has no audio track. Also
/// checks LumaGrid. The size is odd on purpose, as real phones' are
/// (1179x2556). Frames are flat white, so any letterbox bar that isn't
/// black shows up in a brightness check.
///
/// `realtime` paces frames on the wall clock like a capture, so the helper
/// can be killed mid-take to check that the fragments written so far play.
func selftest(path: String, seconds: Int, realtime: Bool, audio: String) -> Never {
    let url = URL(fileURLWithPath: path)
    let (width, height, fps) = (393, 851, 30)
    let start = CMTime(value: 90_000, timescale: 30) // not zero, like a real clock

    do {
        let writer = try MovieWriter(url: url, width: width, height: height, startPTS: start,
                                     audio: audio == "none" ? nil : AudioFormat(), realtime: realtime)
        let portrait = flatFrame(width, height), landscape = flatFrame(height, width)
        let white = LumaGrid.sample(portrait)
        guard white.count == LumaGrid.columns * LumaGrid.rows, !LumaGrid.differ(white, LumaGrid.sample(portrait)),
              LumaGrid.differ(white, LumaGrid.sample(flatFrame(width, height, luma: 200)))
        else { throw writerError("LumaGrid can't tell a changed frame from a frozen one.") }
        let total = seconds * fps
        let began = Date()
        for i in 0..<total {
            if realtime {
                let due = began.addingTimeInterval(Double(i) / Double(fps))
                let wait = due.timeIntervalSinceNow
                if wait > 0 { usleep(useconds_t(wait * 1_000_000)) }
                if i % fps == 0 { FileHandle.standardError.write("selftest: \(i / fps)s\n".data(using: .utf8)!) }
            }
            let pts = CMTimeAdd(start, CMTime(value: CMTimeValue(i), timescale: CMTimeScale(fps)))
            let source = (total / 2..<total * 3 / 4).contains(i) ? landscape : portrait
            if audio == "late", source === landscape, let tone = toneAudio(at: pts, frames: 48_000 / fps, index: i) {
                _ = writer.appendAudio(tone)
            }
            // Real time paces a capture; here, wait for the encoder instead.
            var tries = 0
            while !writer.appendVideo(source, at: pts) {
                if let error = writer.failure { throw error }
                tries += 1
                if tries > 500 { throw writerError("Frame \(i) was never accepted.") }
                usleep(2_000)
            }
        }
        let end = CMTimeAdd(start, CMTime(value: CMTimeValue(total), timescale: CMTimeScale(fps)))
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

/// A 440 Hz tone in the writer's layout, as the capture output delivers it.
func toneAudio(at pts: CMTime, frames: Int, index: Int) -> CMSampleBuffer? {
    pcmAudio(AudioFormat(), at: CMTimeConvertScale(pts, timescale: 48_000, method: .roundHalfAwayFromZero), frames: frames) { out in
        for f in 0..<frames {
            let v = Float(0.25 * sin(2 * Double.pi * 440 * Double(index * frames + f) / 48_000))
            out[2 * f] = v
            out[2 * f + 1] = v
        }
    }
}

/// Feed a synthetic phone screen (a moving dot over a grid of tiles) at
/// 30 fps through the preview sink on `fd`, as serve does for a real phone.
/// For checking the frame pipe, and for driving the app's preview UI with
/// no phone. Ends with {"event":"selftest-preview","offered":n,"sent":n}.
func selftestPreview(fd: Int32, seconds: Double) -> Never {
    guard let sink = PreviewSink.open(fd: fd) else {
        emitError("selftest-preview: fd \(fd) is not a pipe or socket.")
        exit(1)
    }
    let (w, h, fps) = (590, 1278, 30.0)
    let colors: [(CGFloat, CGFloat, CGFloat)] = [
        (0.99, 0.36, 0.33), (0.30, 0.78, 0.47), (0.25, 0.55, 0.98), (1.0, 0.8, 0.2), (0.7, 0.4, 0.95),
    ]
    func draw(_ t: Double) -> CVPixelBuffer? {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA,
                            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &pb)
        guard let pb else { return nil }
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        guard let ctx = CGContext(
            data: CVPixelBufferGetBaseAddress(pb), width: w, height: h, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        let shade = CGFloat(0.5 + 0.5 * sin(t / 3))
        ctx.setFillColor(red: 0.08, green: 0.1 + 0.08 * shade, blue: 0.22, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        let tile = CGFloat(w) / 5.5, gap = tile * 0.3
        for row in 0..<5 {
            for col in 0..<4 {
                let (r, g, b) = colors[(row * 4 + col) % colors.count]
                ctx.setFillColor(red: r, green: g, blue: b, alpha: 1)
                let rect = CGRect(x: gap + CGFloat(col) * (tile + gap * 0.66), y: CGFloat(h) - 160 - CGFloat(row) * (tile + gap) - tile,
                                  width: tile, height: tile)
                ctx.addPath(CGPath(roundedRect: rect, cornerWidth: tile * 0.22, cornerHeight: tile * 0.22, transform: nil))
                ctx.fillPath()
            }
        }
        let x = CGFloat(w) * CGFloat(0.5 + 0.38 * sin(t * 1.3)), y = CGFloat(h) * CGFloat(0.35 + 0.25 * cos(t * 0.9))
        ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 0.85)
        ctx.fillEllipse(in: CGRect(x: x - 34, y: y - 34, width: 68, height: 68))
        return pb
    }
    var offered = 0
    let began = Date()
    var i = 0
    while Double(i) / fps < seconds {
        let due = began.addingTimeInterval(Double(i) / fps)
        let wait = due.timeIntervalSinceNow
        if wait > 0 { usleep(useconds_t(wait * 1_000_000)) }
        if let frame = draw(Double(i) / fps), sink.offer(frame) { offered += 1 }
        i += 1
    }
    sink.drain()
    emit(["event": "selftest-preview", "frames": i, "offered": offered, "sent": sink.sent])
    exit(sink.sent > 0 ? 0 : 1)
}

// MARK: - main

// A reader that went away must not kill the helper mid-take.
signal(SIGPIPE, SIG_IGN)

let args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
switch args.first {
case "list":
    list(waitMs: max(0, option("--wait").flatMap { Int($0) } ?? 3000))
case "record" where args.count >= 3:
    record(id: args[1], path: args[2])
case "serve":
    serve(previewFD: option("--preview-fd").flatMap { Int32($0) })
case "selftest" where args.count >= 2:
    selftest(path: args[1], seconds: max(1, option("--seconds").flatMap { Int($0) } ?? 4),
             realtime: args.contains("--realtime"), audio: option("--audio") ?? "silent")
case "selftest-preview":
    selftestPreview(fd: option("--fd").flatMap { Int32($0) } ?? 3,
                    seconds: max(0.1, option("--seconds").flatMap { Double($0) } ?? 2))
default:
    FileHandle.standardError.write(
        ("usage: ios-capture list [--wait ms] | record <uniqueID> <out.mov> | serve [--preview-fd 3]\n"
         + "       | selftest <out.mov> [--seconds 4] [--realtime] [--audio silent|late|none] | selftest-preview [--seconds 2] [--fd 3]\n").data(using: .utf8)!)
    exit(2)
}
