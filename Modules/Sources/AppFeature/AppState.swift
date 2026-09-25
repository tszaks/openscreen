import Foundation
import OpenScreenCore
import SwiftUI

/// App-wide state machine: source → recording → editor → export.
@MainActor
public final class AppState: ObservableObject {
    public enum Phase: Equatable {
        case sourcePicker
        case recording(startedAt: Date)
        case editor(bundleURL: URL)
        case exporting(progress: Double)
    }

    @Published public var phase: Phase = .sourcePicker
    @Published public var lastError: String?
    @Published public var availableSources: [SourceOption] = []

    public init() {}
}

/// A selectable capture source in the picker UI.
public struct SourceOption: Identifiable, Hashable, Sendable {
    public enum Kind: Sendable {
        case display
        case window
        case region
        case iosDevice
        case synthetic
    }

    public let id: String
    public let kind: Kind
    public let title: String
    public let subtitle: String?

    public init(id: String, kind: Kind, title: String, subtitle: String? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
    }
}
