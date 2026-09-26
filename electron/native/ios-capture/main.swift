// ios-capture: wired iPhone/iPad SCREEN capture, the way QuickTime's
// "New Movie Recording -> iPhone" does it.
//
// iOS screens only show up as capture devices after a process opts in via
// the CoreMediaIO property kCMIOHardwarePropertyAllowScreenCaptureDevices.
// Chromium never does that (and captures in its own utility process), so the
// Electron app drives this small helper instead.
//
//   ios-capture list [--wait ms]          one JSON array of devices, then exit
//   ios-capture record <uniqueID> <out>   record until SIGINT/SIGTERM or a
//                                         "stop" line on stdin, then exit
//   ios-capture serve                     long-lived; what the app uses
//
// The opt-in blocks for up to ~5s in every new process, so the app keeps one
// `serve` process alive rather than paying that per poll or per recording.
//
// stdout is one JSON object per line:
//   {"event":"devices","devices":[{"id","name","modelID","manufacturer"}]}
//   {"event":"started","width":..,"height":..}
//   {"event":"finished","path":..,"width":..,"height":..,"duration":..}
//   {"event":"error","message":..}
// serve reads one command per line on stdin:
//   {"cmd":"record","id":"<uniqueID>","path":"/abs/out.mov"}
//   {"cmd":"stop"}      (a bare "stop" line also works)

import AVFoundation
import CoreMediaIO
import Foundation

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

// MARK: - recording

final class Recorder: NSObject, AVCaptureFileOutputRecordingDelegate {
    let session = AVCaptureSession()
    let output = AVCaptureMovieFileOutput()
    let device: AVCaptureDevice
    let url: URL
    /// Called exactly once with the terminal event ("finished" or "error").
    private let onEnd: ([String: Any]) -> Void
    private var stopping = false
    private var began = false
    private var ended = false
    private var observers: [NSObjectProtocol] = []

    init(device: AVCaptureDevice, url: URL, onEnd: @escaping ([String: Any]) -> Void) {
        self.device = device
        self.url = url
        self.onEnd = onEnd
    }

    private func end(_ event: [String: Any]) {
        guard !ended else { return }
        ended = true
        observers.forEach(NotificationCenter.default.removeObserver)
        if session.isRunning { session.stopRunning() }
        onEnd(event)
    }

    private func fail(_ message: String) {
        end(["event": "error", "message": message])
    }

    func start() {
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            return fail("Could not open \(device.localizedName): \(error.localizedDescription)")
        }
        session.beginConfiguration()
        guard session.canAddInput(input) else { return fail("The capture session rejected the device input.") }
        session.addInput(input)
        guard session.canAddOutput(output) else { return fail("The capture session rejected the movie output.") }
        session.addOutput(output)
        session.commitConfiguration()

        // Chromium can't decode HEVC, so pin the video track to H.264. The
        // device's own audio (a muxed stream) is kept.
        guard let video = output.connection(with: .video) else { return fail("The device has no video stream.") }
        output.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: video)

        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .AVCaptureSessionRuntimeError, object: session, queue: .main
        ) { [weak self] note in
            let err = note.userInfo?[AVCaptureSessionErrorKey] as? Error
            if self?.began == true {
                self?.stop() // keep what was recorded
            } else {
                self?.fail("Capture failed: \(err?.localizedDescription ?? "unknown error")")
            }
        })
        // Cable pulled: finalize what we have; didFinishRecording reports it.
        observers.append(center.addObserver(
            forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: .main
        ) { [weak self] _ in
            if self?.began == true { self?.stop() } else { self?.fail("The device disconnected.") }
        })

        try? FileManager.default.removeItem(at: url)
        session.startRunning()
        output.startRecording(to: url, recordingDelegate: self)
    }

    func stop() {
        guard !stopping else { return }
        stopping = true
        // Before the first frame there's no file to finalize yet; the
        // didStart callback finishes the stop instead.
        if began { output.stopRecording() }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        began = true
        let d = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        emit(["event": "started", "width": Int(d.width), "height": Int(d.height)])
        if stopping { output.stopRecording() }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        // An error here can still mean a complete file (e.g. the cable was
        // pulled); AVFoundation says so via this userInfo flag.
        if let error = error as NSError? {
            let ok = (error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) ?? false
            if !ok { return fail("Recording failed: \(error.localizedDescription)") }
        }
        var event: [String: Any] = ["event": "finished", "path": outputFileURL.path]
        // Read the true size and length back from the finished file: the
        // phone may have rotated since "started" was reported.
        let asset = AVURLAsset(url: outputFileURL)
        if let track = asset.tracks(withMediaType: .video).first {
            let size = track.naturalSize.applying(track.preferredTransform)
            event["width"] = Int(abs(size.width).rounded())
            event["height"] = Int(abs(size.height).rounded())
        }
        let seconds = CMTimeGetSeconds(asset.duration)
        if seconds.isFinite { event["duration"] = seconds }
        end(event)
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
default:
    FileHandle.standardError.write(
        "usage: ios-capture list [--wait ms] | record <uniqueID> <out.mov> | serve\n".data(using: .utf8)!)
    exit(2)
}
