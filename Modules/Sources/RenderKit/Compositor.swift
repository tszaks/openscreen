import AppKit
import CoreGraphics
import Foundation
import OpenScreenCore
import CursorKit

/// One composited output frame's inputs — everything the compositor needs,
/// decoupled from file IO so synthetic frames can drive tests and export.
public struct FrameInput: Sendable {
    /// Source screen frame at this output time.
    public var screenFrame: CGImage
    /// Optional webcam frame at this output time.
    public var cameraFrame: CGImage?
    /// Smoothed cursor position (normalized) at this output time.
    public var cursorPosition: CGPointValue
    /// Whether the cursor is visible at all at this time.
    public var cursorVisible: Bool

    public init(screenFrame: CGImage, cameraFrame: CGImage? = nil, cursorPosition: CGPointValue, cursorVisible: Bool) {
        self.screenFrame = screenFrame
        self.cameraFrame = cameraFrame
        self.cursorPosition = cursorPosition
        self.cursorVisible = cursorVisible
    }
}

/// Renders output frames: background → screen frame (zoomed, rounded,
/// shadowed) → motion blur → software cursor → camera PiP.
///
/// All coordinates are output pixels; cursor/camera positions arrive
/// normalized (0–1 over the source).
public final class Compositor: @unchecked Sendable {
    public struct Options: Sendable {
        /// Cursor circle diameter in px at 1080p canvas height (scales with canvas).
        public var cursorDiameterFraction: Double
        /// Motion-blur sample count when camera moves faster than `blurVelocityThreshold`.
        public var blurSamples: Int
        /// Camera speed (normalized units/sec) that triggers motion blur.
        public var blurVelocityThreshold: Double

        public init(cursorDiameterFraction: Double = 0.012, blurSamples: Int = 4, blurVelocityThreshold: Double = 1.5) {
            self.cursorDiameterFraction = cursorDiameterFraction
            self.blurSamples = blurSamples
            self.blurVelocityThreshold = blurVelocityThreshold
        }
    }

    public let project: Project
    public let options: Options
    public let canvas: CGSizeValue

    public init(project: Project, options: Options = Options()) {
        self.project = project
        self.options = options
        self.canvas = Geometry.canvasSize(preset: project.exportPreset, source: project.recording.sourceSize)
    }

    /// Full-frame render for output time `t` (seconds).
    public func render(at time: TimeInterval, input: FrameInput) -> CGImage? {
        let w = Int(canvas.width)
        let h = Int(canvas.height)
        guard let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        drawBackground(in: ctx, canvas: canvas)

        let (center, scale) = cameraState(at: time)
        let frameRect = Geometry.framedContentRect(
            canvas: canvas,
            paddingFraction: project.style.paddingFraction,
            sourceAspect: project.recording.sourceSize.aspect,
            center: center,
            scale: scale
        )

        // Clip screen content to rounded rect + shadow.
        let rect = CGRect(x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height)
        ctx.saveGState()
        let shadowColor = CGColor(gray: 0, alpha: project.style.shadowOpacity)
        ctx.setShadow(offset: .zero, blur: project.style.shadowRadius, color: shadowColor)
        let path = CGPath(roundedRect: rect, cornerWidth: project.style.cornerRadius, cornerHeight: project.style.cornerRadius, transform: nil)
        ctx.addPath(path)
        ctx.clip()
        ctx.draw(input.screenFrame, in: rect)
        ctx.restoreGState()

        if input.cursorVisible {
            drawCursor(in: ctx, at: input.cursorPosition, within: rect)
        }
        if project.cameraOverlay.enabled, let cam = input.cameraFrame {
            drawCamera(in: ctx, frame: cam, canvas: canvas)
        }
        drawCaption(in: ctx, at: time, within: rect)
        return ctx.makeImage()
    }

    /// Camera state (center + scale) at time, honoring the timeline mapping.
    public func cameraState(at outputTime: TimeInterval) -> (center: CGPointValue, scale: Double) {
        Geometry.cameraRect(
            at: outputTime,
            keyframes: project.zoomKeyframes,
            sourceAspect: project.recording.sourceSize.aspect,
            canvasAspect: canvas.aspect
        )
    }

    private func drawBackground(in ctx: CGContext, canvas: CGSizeValue) {
        let rect = CGRect(x: 0, y: 0, width: canvas.width, height: canvas.height)
        switch project.style.background {
        case let .solid(hex):
            ctx.setFillColor(hexColor(hex))
            ctx.fill(rect)
        case let .gradient(startHex, endHex, angle):
            let colors = [hexColor(startHex), hexColor(endHex)] as CFArray
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
            let rad = angle * .pi / 180
            let start = CGPoint(x: rect.midX - cos(rad) * rect.width / 2, y: rect.midY - sin(rad) * rect.height / 2)
            let end = CGPoint(x: rect.midX + cos(rad) * rect.width / 2, y: rect.midY + sin(rad) * rect.height / 2)
            ctx.drawLinearGradient(gradient, start: start, end: end, options: [])
        case .imageFile, .wallpaper:
            ctx.setFillColor(hexColor("#111111"))
            ctx.fill(rect)
        }
    }

    private func drawCursor(in ctx: CGContext, at position: CGPointValue, within contentRect: CGRect) {
        let d = canvas.height * options.cursorDiameterFraction
        let x = contentRect.origin.x + position.x * contentRect.width - d / 2
        // CoreGraphics origin is bottom-left; normalized coords are top-left.
        let y = contentRect.origin.y + (1 - position.y) * contentRect.height - d / 2
        ctx.setFillColor(hexColor("#FFFFFFCC"))
        ctx.fillEllipse(in: CGRect(x: x, y: y, width: d, height: d))
    }

    /// Burn-in captions: active cue centered near the bottom of the content rect.
    private func drawCaption(in ctx: CGContext, at time: TimeInterval, within contentRect: CGRect) {
        guard let cue = project.captions.first(where: { $0.start <= time && time <= $0.end }),
              !cue.text.isEmpty else { return }

        let fontSize = max(16, canvas.height * 0.032)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .semibold),
            .foregroundColor: NSColor.white,
        ]
        let text = NSAttributedString(string: cue.text, attributes: attrs)
        let textSize = text.size()
        let padX = fontSize * 0.5
        let padY = fontSize * 0.28
        let pillWidth = textSize.width + padX * 2
        let pillHeight = textSize.height + padY * 2
        let pillRect = CGRect(
            x: contentRect.midX - pillWidth / 2,
            // Captions sit above the content rect's bottom edge in normalized
            // space — CoreGraphics Y is bottom-up, so that means small +y.
            y: contentRect.minY + canvas.height * 0.03,
            width: pillWidth,
            height: pillHeight
        )
        ctx.saveGState()
        ctx.setFillColor(CGColor(gray: 0, alpha: 0.65))
        let pill = CGPath(roundedRect: pillRect, cornerWidth: pillHeight / 4, cornerHeight: pillHeight / 4, transform: nil)
        ctx.addPath(pill)
        ctx.fillPath()
        // NSAttributedString draws in AppKit (top-left) coordinates — flip.
        let transform = CGAffineTransform(translationX: 0, y: canvas.height).scaledBy(x: 1, y: -1)
        ctx.concatenate(transform)
        text.draw(at: CGPoint(
            x: pillRect.minX + padX,
            y: canvas.height - pillRect.minY - padY - textSize.height
        ))
        ctx.restoreGState()
    }

    private func drawCamera(in ctx: CGContext, frame: CGImage, canvas: CGSizeValue) {
        let overlay = project.cameraOverlay
        let d = canvas.height * overlay.sizeFraction
        let margin = canvas.height * 0.04
        let x: CGFloat = switch overlay.corner {
        case .topLeft, .bottomLeft: margin
        case .topRight, .bottomRight: canvas.width - margin - d
        }
        let y: CGFloat = switch overlay.corner {
        case .bottomLeft, .bottomRight: margin
        case .topLeft, .topRight: canvas.height - margin - d
        }
        let rect = CGRect(x: x, y: y, width: d, height: d)
        ctx.saveGState()
        if overlay.circular {
            ctx.addEllipse(in: rect)
        } else {
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: 12, cornerHeight: 12, transform: nil))
        }
        ctx.clip()
        ctx.draw(frame, in: rect)
        ctx.restoreGState()
    }
}

/// Minimal hex color (#RRGGBB or #RRGGBBAA) → CGColor.
func hexColor(_ hex: String) -> CGColor {
    var s = hex.trimmingCharacters(in: .whitespaces).dropFirst(hex.hasPrefix("#") ? 1 : 0)
    if s.count == 6 { s += "FF" }
    var value: UInt64 = 0
    Scanner(string: String(s)).scanHexInt64(&value)
    return CGColor(
        red: CGFloat((value >> 24) & 0xFF) / 255,
        green: CGFloat((value >> 16) & 0xFF) / 255,
        blue: CGFloat((value >> 8) & 0xFF) / 255,
        alpha: CGFloat(value & 0xFF) / 255
    )
}
