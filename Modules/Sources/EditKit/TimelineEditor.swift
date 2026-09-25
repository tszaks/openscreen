import Foundation
import OpenScreenCore

/// Mutable timeline: ordered clips mapping source media into output time.
public struct Timeline: Codable, Equatable, Sendable {
    public private(set) var clips: [Clip]
    /// Total source media length available for clipping.
    public let sourceDuration: TimeInterval

    public init(sourceDuration: TimeInterval, clips: [Clip]? = nil) {
        self.sourceDuration = sourceDuration
        self.clips = clips ?? [Clip(sourceStart: 0, sourceEnd: sourceDuration)]
    }

    /// Total output duration after trims and speed changes.
    public var outputDuration: TimeInterval {
        clips.reduce(0) { $0 + $1.outputDuration }
    }

    /// Split the clip covering output `time` into two clips at that point.
    /// Returns false if the time lands outside any clip or on a boundary.
    @discardableResult
    public mutating func split(at time: TimeInterval) -> Bool {
        var cursor: TimeInterval = 0
        for (index, clip) in clips.enumerated() {
            let clipEnd = cursor + clip.outputDuration
            if time > cursor, time < clipEnd {
                let sourceSplit = clip.sourceStart + (time - cursor) * clip.speed
                let first = Clip(id: clip.id, sourceStart: clip.sourceStart, sourceEnd: sourceSplit, speed: clip.speed)
                let second = Clip(sourceStart: sourceSplit, sourceEnd: clip.sourceEnd, speed: clip.speed)
                clips.replaceSubrange(index...index, with: [first, second])
                return true
            }
            cursor = clipEnd
        }
        return false
    }

    /// Move a clip's source end boundaries (trim). Values clamped to source.
    public mutating func trim(clipID: Clip.ID, newSourceStart: TimeInterval? = nil, newSourceEnd: TimeInterval? = nil) {
        guard let i = clips.firstIndex(where: { $0.id == clipID }) else { return }
        if let s = newSourceStart {
            clips[i].sourceStart = s.clamped(to: 0...clips[i].sourceEnd)
        }
        if let e = newSourceEnd {
            clips[i].sourceEnd = e.clamped(to: clips[i].sourceStart...sourceDuration)
        }
    }

    public mutating func setSpeed(clipID: Clip.ID, speed: Double) {
        guard let i = clips.firstIndex(where: { $0.id == clipID }) else { return }
        clips[i].speed = speed.clamped(to: 0.25...8)
    }

    public mutating func remove(clipID: Clip.ID) {
        clips.removeAll { $0.id == clipID }
    }

    public mutating func move(clipID: Clip.ID, to newIndex: Int) {
        guard let i = clips.firstIndex(where: { $0.id == clipID }), i != newIndex else { return }
        let clip = clips.remove(at: i)
        clips.insert(clip, at: newIndex.clamped(to: 0...clips.count))
    }

    /// Map output timeline time back to source time (needed to render frames).
    /// Returns nil when `time` falls past the end.
    public func sourceTime(atOutputTime time: TimeInterval) -> TimeInterval? {
        var cursor: TimeInterval = 0
        for clip in clips {
            let clipEnd = cursor + clip.outputDuration
            if time < clipEnd {
                return clip.sourceStart + (time - cursor) * clip.speed
            }
            cursor = clipEnd
        }
        return nil
    }
}
