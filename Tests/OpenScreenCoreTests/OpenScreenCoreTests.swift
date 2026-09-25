import Foundation
import OpenScreenCore
import Testing

@Suite("Geometry")
struct GeometryTests {
    @Test func smoothstepEndpoints() {
        #expect(Geometry.smoothstep(0) == 0)
        #expect(Geometry.smoothstep(1) == 1)
        let mid = Geometry.smoothstep(0.5)
        #expect(mid > 0.4 && mid < 0.6)
    }

    @Test func cameraRectInterpolates() {
        let keys = [
            ZoomKeyframe(time: 0, center: CGPointValue(x: 0.5, y: 0.5), scale: 1),
            ZoomKeyframe(time: 1, center: CGPointValue(x: 0.25, y: 0.25), scale: 2),
        ]
        let r = Geometry.cameraRect(
            at: 1.5,
            keyframes: keys,
            sourceAspect: 16.0 / 9.0,
            canvasAspect: 16.0 / 9.0
        )
        #expect(abs(r.scale - 2) < 0.01)
    }

    @Test func framedRectFitsCanvas() {
        let canvas = CGSizeValue(width: 1920, height: 1080)
        let r = Geometry.framedContentRect(
            canvas: canvas,
            paddingFraction: 0.1,
            sourceAspect: 16.0 / 9.0,
            center: CGPointValue(x: 0.5, y: 0.5),
            scale: 1
        )
        #expect(r.width <= canvas.width * 0.85)
        #expect(r.height <= canvas.height * 0.85)
    }

    @Test func canvasSizeByPreset() {
        let src = CGSizeValue(width: 3840, height: 2160)
        #expect(Geometry.canvasSize(preset: .square1080, source: src).width == 1080)
        #expect(Geometry.canvasSize(preset: .portrait1080x1920, source: src).height == 1920)
        #expect(Geometry.canvasSize(preset: .original, source: src).width == 3840)
    }
}

@Suite("Models")
struct ModelTests {
    @Test func projectRoundTrips() throws {
        let project = Project(
            recording: RecordingRef(
                screenVideoFile: "screen.mp4",
                sourceKind: .display,
                sourceSize: CGSizeValue(width: 2560, height: 1440),
                duration: 12.5
            ),
            clips: [Clip(sourceStart: 0, sourceEnd: 12.5, speed: 1.5)],
            zoomKeyframes: [ZoomKeyframe(time: 1, center: CGPointValue(x: 0.3, y: 0.4), scale: 2)],
            captions: [CaptionCue(start: 0, end: 0.5, text: "hello")]
        )
        let data = try JSONEncoder.openScreen.encode(project)
        let back = try JSONDecoder.openScreen.decode(Project.self, from: data)
        #expect(back == project)
    }

    @Test func clipOutputDurationRespectsSpeed() {
        let clip = Clip(sourceStart: 0, sourceEnd: 10, speed: 2)
        #expect(clip.outputDuration == 5)
        #expect(clip.sourceDuration == 10)
    }
}

@Suite("RecordingBundle")
struct BundleTests {
    @Test func saveAndLoadRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-\(UUID().uuidString).openscreen", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let project = Project(
            recording: RecordingRef(
                screenVideoFile: "screen.mp4",
                sourceKind: .synthetic,
                sourceSize: CGSizeValue(width: 1280, height: 720),
                duration: 3
            ),
            clips: [Clip(sourceStart: 0, sourceEnd: 3)]
        )
        let bundle = RecordingBundle(directory: dir, project: project)
        try bundle.save()

        let loaded = try RecordingBundle.load(from: dir)
        #expect(loaded.project.recording.sourceSize.width == 1280)
    }

    @Test func cursorTrackRoundTrips() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-\(UUID().uuidString).openscreen", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let bundle = RecordingBundle(
            directory: dir,
            project: Project(
                recording: RecordingRef(
                    screenVideoFile: "screen.mp4",
                    sourceKind: .synthetic,
                    sourceSize: CGSizeValue(width: 640, height: 480),
                    duration: 1
                ),
                clips: []
            )
        )
        let samples = [
            CursorSample(time: 0, x: 0.1, y: 0.2),
            CursorSample(time: 0.5, x: 0.5, y: 0.6, kind: .clickDown),
        ]
        try bundle.saveCursorSamples(samples)
        let loaded = try bundle.loadCursorSamples()
        #expect(loaded.count == 2)
        #expect(loaded[1].kind == .clickDown)
    }
}
