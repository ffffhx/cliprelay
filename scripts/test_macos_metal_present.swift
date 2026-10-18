// Standalone CI control: no Qt, SDL, VideoToolbox, capture or network involved.
import AppKit
import MetalKit
import Foundation

final class Renderer: NSObject, MTKViewDelegate {
    let queue: MTLCommandQueue
    let lock = NSLock()
    var submitted = 0, displayed = 0, dropped = 0, gpuErrors = 0
    init(device: MTLDevice) { queue = device.makeCommandQueue()!; super.init() }
    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}
    func draw(in view: MTKView) {
        guard let descriptor = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let command = queue.makeCommandBuffer() else { return }
        lock.lock(); submitted += 1; let index = submitted; lock.unlock()
        descriptor.colorAttachments[0].clearColor = index % 2 == 0
            ? MTLClearColorMake(1, 0, 0, 1) : MTLClearColorMake(0, 1, 0, 1)
        descriptor.colorAttachments[0].storeAction = .store
        guard let encoder = command.makeRenderCommandEncoder(descriptor: descriptor) else { return }
        encoder.endEncoding()
        drawable.addPresentedHandler { frame in
            self.lock.lock()
            if frame.presentedTime > 0 { self.displayed += 1 } else { self.dropped += 1 }
            self.lock.unlock()
        }
        command.addCompletedHandler { buffer in
            if buffer.status == .error { self.lock.lock(); self.gpuErrors += 1; self.lock.unlock() }
        }
        command.present(drawable); command.commit()
    }
}

@main struct Main {
    static func main() {
        guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
              let device = MTLCreateSystemDefaultDevice() else { exit(2) }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let rectangle = NSRect(x: 100, y: 100, width: 640, height: 360)
        let window = NSWindow(contentRect: rectangle, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "ClipRelay Metal CI control"
        let view = MTKView(frame: rectangle, device: device), renderer = Renderer(device: device)
        view.preferredFramesPerSecond = 30; view.delegate = renderer
        window.contentView = view; window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true)
        var passed = false
        DispatchQueue.global().asyncAfter(deadline: .now() + 12) { exit(3) }
        let timer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in
            renderer.lock.lock()
            let submitted = renderer.submitted, displayed = renderer.displayed, dropped = renderer.dropped, gpuErrors = renderer.gpuErrors
            renderer.lock.unlock()
            passed = displayed >= 60 && gpuErrors == 0
            let report: [String: Any] = ["protocol": 1, "passed": passed, "testCommit": ProcessInfo.processInfo.environment["GITHUB_SHA"] ?? "",
                "gpu": device.name, "submitted": submitted, "displayed": displayed,
                "dropped": dropped, "gpuErrors": gpuErrors,
                "windowVisible": window.isVisible, "windowOcclusionVisible": window.occlusionState.contains(.visible),
                "applicationActive": app.isActive, "screenContentSaved": false]
            FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]))
            exit(passed ? 0 : 1)
        }
        app.run(); timer.invalidate(); view.isPaused = true; window.orderOut(nil)
        withExtendedLifetime(renderer) {}
        exit(passed ? 0 : 1)
    }
}
