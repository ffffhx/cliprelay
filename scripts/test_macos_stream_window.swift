// Inspect/activate only the CI-owned viewer. Never collect window titles or images.
import AppKit
import CoreGraphics
import Foundation

guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
      CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]), pid > 1,
      let app = NSRunningApplication(processIdentifier: pid),
      app.bundleIdentifier == "com.cliprelay.stream" else { exit(2) }
func state() -> [String: Any] {
    let windows = (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? [])
        .filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
        .map { item -> [String: Any] in
            ["onscreen": item[kCGWindowIsOnscreen as String] ?? false,
             "layer": item[kCGWindowLayer as String] ?? -1,
             "bounds": item[kCGWindowBounds as String] ?? [:]]
        }
    return ["active": app.isActive, "hidden": app.isHidden, "windows": windows]
}
let before = state()
let activated = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
let output = try JSONSerialization.data(withJSONObject: ["before": before, "activationAccepted": activated, "after": state()], options: [.sortedKeys])
FileHandle.standardOutput.write(output)
