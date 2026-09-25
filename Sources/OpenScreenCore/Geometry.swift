import Foundation

/// Camera/output geometry: turns zoom keyframes + style into pixel rects.
public enum Geometry {
    /// Ease-in-out smoothstep for transitions.
    public static func smoothstep(_ t: Double) -> Double {
        let x = t.clamped(to: 0...1)
        return x * x * (3 - 2 * x)
    }

    /// The normalized rect the output camera sees at `time`, given keyframes.
    /// scale=1 → full frame; scale=2 → half-size rect centered on `center`.
    public static func cameraRect(
        at time: TimeInterval,
        keyframes: [ZoomKeyframe],
        sourceAspect: Double,
        canvasAspect: Double
    ) -> (center: CGPointValue, scale: Double) {
        let sorted = keyframes.sorted { $0.time < $1.time }
        guard let first = sorted.first else {
            return (CGPointValue(x: 0.5, y: 0.5), 1)
        }
        if time <= first.time { return (first.center, first.scale) }
        if let last = sorted.last, time >= last.time { return (last.center, last.scale) }

        var lower = first
        var upper = sorted.last!
        for (a, b) in zip(sorted, sorted.dropFirst()) where time >= a.time && time <= b.time {
            lower = a
            upper = b
        }
        let span = upper.time - lower.time
        let t = span > 0 ? smoothstep((time - lower.time) / span) : 1
        let center = CGPointValue(
            x: lower.center.x + (upper.center.x - lower.center.x) * t,
            y: lower.center.y + (upper.center.y - lower.center.y) * t
        )
        let scale = lower.scale + (upper.scale - lower.scale) * t
        return (center, scale)
    }

    /// Pixel-space rect of the source inside `canvas` after padding, at zoom
    /// `scale` about `center` (normalized). Returns the destination rect the
    /// screen frame is drawn into — scaled so `1/scale` of the source fills it.
    public static func framedContentRect(
        canvas: CGSizeValue,
        paddingFraction: Double,
        sourceAspect: Double,
        center: CGPointValue,
        scale: Double
    ) -> CGRectValue {
        let padX = canvas.width * paddingFraction
        let padY = canvas.height * paddingFraction
        let availW = canvas.width - padX * 2
        let availH = canvas.height - padY * 2

        // Fit source aspect inside available area.
        var w = availW
        var h = w / sourceAspect
        if h > availH {
            h = availH
            w = h * sourceAspect
        }

        // Center the fitted rect.
        let baseX = (canvas.width - w) / 2
        let baseY = (canvas.height - h) / 2

        // Zoom: keep `center` (normalized to the fitted rect) fixed on screen.
        let scaledW = w * scale
        let scaledH = h * scale
        let anchorX = baseX + w * center.x
        let anchorY = baseY + h * center.y
        let scaledX = anchorX - scaledW * center.x
        let scaledY = anchorY - scaledH * center.y

        return CGRectValue(x: scaledX, y: scaledY, width: scaledW, height: scaledH)
    }

    /// Canvas size for a preset given the source recording size.
    public static func canvasSize(preset: ExportPreset, source: CGSizeValue) -> CGSizeValue {
        preset.canvasSize ?? source
    }
}

/// Codable, platform-free CGRect.
public struct CGRectValue: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

extension Comparable {
    public func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
