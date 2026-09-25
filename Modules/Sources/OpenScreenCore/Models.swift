import Foundation

/// A single cursor observation captured during recording.
/// Position is normalized to the recorded display's bounds ([0,1]).
public struct CursorSample: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case move
        case clickDown
        case clickUp
        case dragMove
    }

    /// Seconds since recording start.
    public var time: TimeInterval
    public var x: Double
    public var y: Double
    public var kind: Kind

    public init(time: TimeInterval, x: Double, y: Double, kind: Kind = .move) {
        self.time = time
        self.x = x
        self.y = y
        self.kind = kind
    }
}

/// A camera zoom instruction: at `time`, look at `center` at `scale`.
/// `center` is normalized to the source frame ([0,1], origin top-left).
public struct ZoomKeyframe: Codable, Equatable, Sendable {
    public var time: TimeInterval
    public var center: CGPointValue
    public var scale: Double

    public init(time: TimeInterval, center: CGPointValue, scale: Double) {
        self.time = time
        self.center = center
        self.scale = scale
    }
}

/// Codable, platform-free CGPoint (avoids CoreGraphics in Core).
public struct CGPointValue: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public static let zero = CGPointValue(x: 0, y: 0)
}

/// A timeline segment mapping a source range into the output at `speed`.
public struct Clip: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    /// Source range this clip plays, in seconds.
    public var sourceStart: TimeInterval
    public var sourceEnd: TimeInterval
    /// Playback speed multiplier (1 = normal).
    public var speed: Double

    public init(id: UUID = UUID(), sourceStart: TimeInterval, sourceEnd: TimeInterval, speed: Double = 1) {
        self.id = id
        self.sourceStart = sourceStart
        self.sourceEnd = sourceEnd
        self.speed = speed
    }

    /// Seconds of source media covered.
    public var sourceDuration: TimeInterval { sourceEnd - sourceStart }

    /// Seconds of output timeline this clip occupies.
    public var outputDuration: TimeInterval { sourceDuration / max(speed, .ulpOfOne) }
}

/// Visual frame styling around the recorded content.
public struct StyleSettings: Codable, Equatable, Sendable {
    public enum Background: Codable, Equatable, Sendable {
        case gradient(startHex: String, endHex: String, angleDegrees: Double)
        case solid(hex: String)
        case imageFile(name: String, blur: Double)
        case wallpaper
    }

    public var background: Background
    /// Fraction of the canvas inset on each side (0–0.4).
    public var paddingFraction: Double
    /// Corner radius applied to the screen frame, in output pixels.
    public var cornerRadius: Double
    /// Shadow radius in output pixels.
    public var shadowRadius: Double
    /// Shadow opacity 0–1.
    public var shadowOpacity: Double

    public init(
        background: Background = .gradient(startHex: "#3A7BFA", endHex: "#9B51E0", angleDegrees: 135),
        paddingFraction: Double = 0.12,
        cornerRadius: Double = 24,
        shadowRadius: Double = 40,
        shadowOpacity: Double = 0.35
    ) {
        self.background = background
        self.paddingFraction = paddingFraction
        self.cornerRadius = cornerRadius
        self.shadowRadius = shadowRadius
        self.shadowOpacity = shadowOpacity
    }
}

/// Where (and whether) the webcam bubble sits on the canvas.
public struct CameraOverlay: Codable, Equatable, Sendable {
    public enum Corner: String, Codable, Sendable {
        case topLeft, topRight, bottomLeft, bottomRight
    }

    public var enabled: Bool
    public var corner: Corner
    /// Diameter as a fraction of canvas height (0–0.5).
    public var sizeFraction: Double
    /// Circular crop vs rounded rect.
    public var circular: Bool

    public init(enabled: Bool = false, corner: Corner = .bottomLeft, sizeFraction: Double = 0.22, circular: Bool = true) {
        self.enabled = enabled
        self.corner = corner
        self.sizeFraction = sizeFraction
        self.circular = circular
    }
}

/// Caption text over a range of output time.
public struct CaptionCue: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var start: TimeInterval
    public var end: TimeInterval
    public var text: String

    public init(id: UUID = UUID(), start: TimeInterval, end: TimeInterval, text: String) {
        self.id = id
        self.start = start
        self.end = end
        self.text = text
    }
}

/// Export canvas preset.
public enum ExportPreset: String, Codable, CaseIterable, Sendable {
    /// Match the recording's native pixel size.
    case original
    /// 1920×1080 landscape.
    case landscape1080
    /// 1080×1920 portrait — social vertical.
    case portrait1080x1920
    /// 1080×1080 square.
    case square1080
    /// 3840×2160 HEVC.
    case uhd4k

    public var canvasSize: CGSizeValue? {
        switch self {
        case .original: return nil
        case .landscape1080: return CGSizeValue(width: 1920, height: 1080)
        case .portrait1080x1920: return CGSizeValue(width: 1080, height: 1920)
        case .square1080: return CGSizeValue(width: 1080, height: 1080)
        case .uhd4k: return CGSizeValue(width: 3840, height: 2160)
        }
    }
}

public struct CGSizeValue: Codable, Equatable, Sendable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }

    public var aspect: Double { width / max(height, .ulpOfOne) }
}

/// The editable project document (`.openscreen` bundle JSON).
public struct Project: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var recording: RecordingRef
    public var clips: [Clip]
    public var zoomKeyframes: [ZoomKeyframe]
    public var style: StyleSettings
    public var cameraOverlay: CameraOverlay
    public var captions: [CaptionCue]
    public var exportPreset: ExportPreset
    /// Frame rate of the output render.
    public var outputFPS: Int

    public init(
        recording: RecordingRef,
        clips: [Clip],
        zoomKeyframes: [ZoomKeyframe] = [],
        style: StyleSettings = StyleSettings(),
        cameraOverlay: CameraOverlay = CameraOverlay(),
        captions: [CaptionCue] = [],
        exportPreset: ExportPreset = .original,
        outputFPS: Int = 60
    ) {
        self.schemaVersion = Project.currentSchemaVersion
        self.recording = recording
        self.clips = clips
        self.zoomKeyframes = zoomKeyframes
        self.style = style
        self.cameraOverlay = cameraOverlay
        self.captions = captions
        self.exportPreset = exportPreset
        self.outputFPS = outputFPS
    }
}

/// Reference to the recorded media inside a bundle.
public struct RecordingRef: Codable, Equatable, Sendable {
    public enum SourceKind: String, Codable, Sendable {
        case display
        case window
        case region
        case iosDevice
        case synthetic
    }

    public var screenVideoFile: String
    public var cameraVideoFile: String?
    public var audioFile: String?
    /// Cursor/click track JSON file inside the bundle.
    public var cursorTrackFile: String
    public var sourceKind: SourceKind
    /// Native pixel size of the screen recording.
    public var sourceSize: CGSizeValue
    /// Total source duration in seconds.
    public var duration: TimeInterval

    public init(
        screenVideoFile: String,
        cameraVideoFile: String? = nil,
        audioFile: String? = nil,
        cursorTrackFile: String = "cursor.json",
        sourceKind: SourceKind,
        sourceSize: CGSizeValue,
        duration: TimeInterval
    ) {
        self.screenVideoFile = screenVideoFile
        self.cameraVideoFile = cameraVideoFile
        self.audioFile = audioFile
        self.cursorTrackFile = cursorTrackFile
        self.sourceKind = sourceKind
        self.sourceSize = sourceSize
        self.duration = duration
    }
}
