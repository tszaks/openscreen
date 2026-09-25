import AppFeature
import SwiftUI

@main
struct OpenScreenApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .windowStyle(.automatic)
        .windowResizability(.contentSize)
    }
}
