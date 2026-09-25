import Foundation

/// A `.openscreen` bundle: directory containing project.json, media, and
/// the cursor track. Layout:
///
///   Foo.openscreen/
///     project.json      ← Project (this file manages it)
///     screen.mp4        ← display/window/USB capture
///     camera.mp4        ← optional webcam
///     audio.m4a         ← optional mic+system mix
///     cursor.json       ← [CursorSample]
public struct RecordingBundle: Sendable {
    public let directory: URL
    public var project: Project

    public init(directory: URL, project: Project) {
        self.directory = directory
        self.project = project
    }

    public var projectFileURL: URL { directory.appendingPathComponent("project.json") }
    public var cursorTrackURL: URL { directory.appendingPathComponent(project.recording.cursorTrackFile) }
    public var screenVideoURL: URL { directory.appendingPathComponent(project.recording.screenVideoFile) }

    /// Load a bundle from disk.
    public static func load(from directory: URL) throws -> RecordingBundle {
        let data = try Data(contentsOf: directory.appendingPathComponent("project.json"))
        let project = try JSONDecoder.openScreen.decode(Project.self, from: data)
        return RecordingBundle(directory: directory, project: project)
    }

    /// Persist project.json (media is written by CaptureKit directly).
    public func save() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder.openScreen.encode(project)
        try data.write(to: projectFileURL, options: .atomic)
    }

    /// Load the recorded cursor track.
    public func loadCursorSamples() throws -> [CursorSample] {
        let data = try Data(contentsOf: cursorTrackURL)
        return try JSONDecoder.openScreen.decode([CursorSample].self, from: data)
    }

    /// Persist the cursor track (CaptureKit's CursorMonitor output).
    public func saveCursorSamples(_ samples: [CursorSample]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder.openScreen.encode(samples)
        try data.write(to: cursorTrackURL, options: .atomic)
    }
}

public extension JSONEncoder {
    static var openScreen: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }
}

public extension JSONDecoder {
    static var openScreen: JSONDecoder { JSONDecoder() }
}
