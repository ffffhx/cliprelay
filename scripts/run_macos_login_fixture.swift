import AppKit
import Foundation

// Launch only the uniquely identified disposable acceptance app through the
// same system application entry point as Finder, with an owned timeout.
let env = ProcessInfo.processInfo.environment
guard env["CI"] == "true", env["GITHUB_ACTIONS"] == "true", CommandLine.arguments.count == 2 else { exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
guard url.path.hasPrefix("/Applications/ClipRelayLoginFixture-"),
      let bundle = Bundle(url: url),
      bundle.bundleIdentifier?.hasPrefix("com.cliprelay.tests.login.fixture") == true else { exit(2) }
let configuration = NSWorkspace.OpenConfiguration()
configuration.activates = false
configuration.createsNewApplicationInstance = true
configuration.addsToRecentItems = false
configuration.environment = env.filter { ["CI", "GITHUB_ACTIONS", "RUNNER_TEMP", "CLIPRELAY_NATIVE_LOGIN_FIXTURE", "CLIPRELAY_NATIVE_LOGIN_OPTIONS"].contains($0.key) }
if let raw = env["CLIPRELAY_NATIVE_LOGIN_OPTIONS"], let data = raw.data(using: .utf8),
   let options = try? JSONSerialization.jsonObject(with: data) as? [String: String],
   let log = options["log"], let temporary = env["RUNNER_TEMP"], log.hasPrefix(temporary + "/") {
    configuration.arguments = ["--enable-logging=file", "--log-file=" + log]
}
var application: NSRunningApplication?
let deadline = Date().addingTimeInterval(25)
var timedOut = false
NSWorkspace.shared.openApplication(at: url, configuration: configuration) { running, error in
    guard error == nil, let running = running, running.bundleURL?.standardizedFileURL == url else {
        fputs("Owned fixture could not launch through NSWorkspace\n", stderr)
        exit(3)
    }
    application = running
}
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    if let running = application, running.isTerminated { exit(timedOut ? 4 : 0) }
    if Date() >= deadline {
        timedOut = true
        if let running = application { running.forceTerminate() }
        if Date().timeIntervalSince(deadline) > 3 { exit(4) }
    }
}
RunLoop.main.run()
