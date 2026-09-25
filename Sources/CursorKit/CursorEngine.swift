import Foundation
import OpenScreenCore

/// Resamples noisy OS cursor samples into a smooth path at a fixed rate.
public struct CursorSmoother: Sendable {
    /// Output sample spacing in seconds (default 1/60).
    public var step: TimeInterval
    /// Minimum movement (normalized units/sec) below which the cursor is "dwelling" — snaps to rest.
    public var dwellSpeed: Double

    public init(step: TimeInterval = 1.0 / 60.0, dwellSpeed: Double = 0.002) {
        self.step = step
        self.dwellSpeed = dwellSpeed
    }

    /// Catmull-Rom interpolation over the move/drag samples, resampled at `step`.
    /// Click events are passed through untouched into the result (sorted by time).
    public func smoothedPath(from samples: [CursorSample]) -> [CursorSample] {
        let moves = samples
            .filter { $0.kind == .move || $0.kind == .dragMove }
            .sorted { $0.time < $1.time }
        guard moves.count >= 2 else { return samples.sorted { $0.time < $1.time } }

        var result: [CursorSample] = []
        let t0 = moves.first!.time
        let t1 = moves.last!.time
        var t = t0
        while t <= t1 {
            result.append(CursorSample(time: t, x: position(at: t, in: moves).x, y: position(at: t, in: moves).y))
            t += step
        }
        // Preserve click events in the smoothed stream.
        let clicks = samples.filter { $0.kind == .clickDown || $0.kind == .clickUp }
        result.append(contentsOf: clicks)
        return result.sorted { $0.time < $1.time }
    }

    /// Interpolated position at `time` using Catmull-Rom over neighboring samples.
    public func position(at time: TimeInterval, in moves: [CursorSample]) -> CGPointValue {
        guard !moves.isEmpty else { return CGPointValue(x: 0.5, y: 0.5) }
        if time <= moves.first!.time { return CGPointValue(x: moves.first!.x, y: moves.first!.y) }
        if time >= moves.last!.time { return CGPointValue(x: moves.last!.x, y: moves.last!.y) }

        // Binary search for surrounding pair.
        var lo = 0
        var hi = moves.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if moves[mid].time <= time { lo = mid } else { hi = mid }
        }
        let p1 = moves[lo]
        let p2 = moves[hi]
        let p0 = lo > 0 ? moves[lo - 1] : p1
        let p3 = hi < moves.count - 1 ? moves[hi + 1] : p2

        let span = p2.time - p1.time
        let u = span > 0 ? (time - p1.time) / span : 0
        return CGPointValue(
            x: catmullRom(p0.x, p1.x, p2.x, p3.x, u),
            y: catmullRom(p0.y, p1.y, p2.y, p3.y, u)
        )
    }

    /// Catmull-Rom spline segment evaluation (u in [0,1] between p1 and p2).
    public func catmullRom(_ p0: Double, _ p1: Double, _ p2: Double, _ p3: Double, _ u: Double) -> Double {
        let u2 = u * u
        let u3 = u2 * u
        return 0.5 * (
            (2 * p1)
                + (-p0 + p2) * u
                + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
                + (-p0 + 3 * p1 - 3 * p2 + p3) * u3
        )
    }
}

/// Turns cursor/click history into zoom keyframes — the "auto zoom" feature:
/// zoom toward where clicks happen, hold while the user interacts, ease back.
public struct ZoomPlanner: Sendable {
    /// Seconds before a click to start zooming in.
    public var leadIn: TimeInterval
    /// Seconds after the last click of a cluster before zooming back out.
    public var holdAfter: TimeInterval
    /// Minimum click spacing to merge into one zoom target.
    public var clusterGap: TimeInterval
    /// Max zoom scale.
    public var maxScale: Double
    /// Normalized distance under which clicks share a zoom center.
    public var mergeRadius: Double

    public init(
        leadIn: TimeInterval = 0.25,
        holdAfter: TimeInterval = 0.8,
        clusterGap: TimeInterval = 1.2,
        maxScale: Double = 2.0,
        mergeRadius: Double = 0.08
    ) {
        self.leadIn = leadIn
        self.holdAfter = holdAfter
        self.clusterGap = clusterGap
        self.maxScale = maxScale
        self.mergeRadius = mergeRadius
    }

    /// Build a keyframe list covering `duration` from click samples.
    /// Always begins and ends at scale 1 (full frame).
    public func plan(clicks: [CursorSample], duration: TimeInterval) -> [ZoomKeyframe] {
        let clickDowns = clicks.filter { $0.kind == .clickDown }.sorted { $0.time < $1.time }
        var keys: [ZoomKeyframe] = [ZoomKeyframe(time: 0, center: CGPointValue(x: 0.5, y: 0.5), scale: 1)]
        guard !clickDowns.isEmpty else {
            keys.append(ZoomKeyframe(time: duration, center: CGPointValue(x: 0.5, y: 0.5), scale: 1))
            return keys
        }

        // Cluster clicks that are close in time and space.
        var clusters: [[CursorSample]] = []
        for click in clickDowns {
            if let last = clusters.last?.last,
               click.time - last.time <= clusterGap,
               hypot(click.x - last.x, click.y - last.y) <= mergeRadius
            {
                clusters[clusters.count - 1].append(click)
            } else {
                clusters.append([click])
            }
        }

        for cluster in clusters {
            let first = cluster.first!
            let last = cluster.last!
            let center = CGPointValue(
                x: cluster.map(\.x).reduce(0, +) / Double(cluster.count),
                y: cluster.map(\.y).reduce(0, +) / Double(cluster.count)
            )
            let zoomIn = max(0, first.time - leadIn)
            let zoomOut = min(duration, last.time + holdAfter)
            keys.append(ZoomKeyframe(time: zoomIn, center: center, scale: maxScale))
            keys.append(ZoomKeyframe(time: zoomOut, center: center, scale: 1))
        }
        keys.append(ZoomKeyframe(time: duration, center: CGPointValue(x: 0.5, y: 0.5), scale: 1))
        keys.sort { $0.time < $1.time }
        return keys
    }
}
