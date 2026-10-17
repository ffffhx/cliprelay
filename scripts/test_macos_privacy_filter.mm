// SPDX-License-Identifier: GPL-3.0-only
// Native owned-window checks only. Display registry events are a fixture;
// readiness from real encoding and a paired client are separate acceptance.
#import <AppKit/AppKit.h>
#import "av_video.h"
#include "cliprelay_privacy.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <libproc.h>
#include <unistd.h>

using namespace cliprelay;
using namespace cliprelay::privacy;
static int client;
static void require(bool value, const char *message) {
  if (!value) { fprintf(stderr, "privacy filter verification failed: %s\n", message); fflush(stderr); exit(1); }
}
static std::string line() {
  std::string value;
  require(static_cast<bool>(std::getline(std::cin, value)) && value.size() <= 8192, "bounded fixture message");
  return value;
}
static void event(const char *value) { printf("{\"event\":\"%s\"}\n", value); fflush(stdout); }
static void pixel(AVVideoFrameSource *source, AVVideo *owner, CGPoint point, bool red) {
  auto until = std::chrono::steady_clock::now() + std::chrono::seconds(4);
  bool matched = false;
  while (std::chrono::steady_clock::now() < until) {
    auto sample = [source copyNextFrameBefore:dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC)];
    if (!sample) continue;
    auto buffer = CMSampleBufferGetImageBuffer(sample);
    require(CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA, "BGRA image");
    const auto bounds = CGDisplayBounds(owner.displayID);
    const auto width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer);
    const size_t x = (point.x - bounds.origin.x) * width / bounds.size.width;
    const size_t y = (point.y - bounds.origin.y) * height / bounds.size.height;
    require(x < width && y < height, "owned pixel bounds");
    require(CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess, "image map");
    const auto *p = static_cast<unsigned char *>(CVPixelBufferGetBaseAddress(buffer)) + y * CVPixelBufferGetBytesPerRow(buffer) + x * 4;
    matched = red ? p[2] > 180 && p[1] < 60 && p[0] < 60 : p[0] < 20 && p[1] < 20 && p[2] < 20;
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    CFRelease(sample);
    if (matched) break;
  }
  require(matched, red ? "new filtered image shows red backdrop" : "new unfiltered image shows native black mask");
}
static void stop(AVVideo *owner, AVVideoFrameSource *source) {
  [owner stopCapture:source]; [source release];
}

int main() {
  @autoreleasepool {
    require(getenv("GITHUB_ACTIONS") && !strcmp(getenv("GITHUB_ACTIONS"), "true"), "disposable Mac CI only");
    require(native_supported(), "owned native capture context");
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSScreen *screen = NSScreen.mainScreen;
    require(screen != nil, "display");
    const auto display_id = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
    const auto bounds = CGDisplayBounds(display_id);
    NSRect rect = NSMakeRect(screen.frame.origin.x + 80, screen.frame.origin.y + 80, 480, 320);
    auto backdrop = [[NSWindow alloc] initWithContentRect:rect styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    backdrop.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1];
    backdrop.opaque = YES; backdrop.hasShadow = NO; backdrop.level = NSFloatingWindowLevel;
    [backdrop orderFrontRegardless];
    const auto backdrop_id = static_cast<std::uint32_t>(backdrop.windowNumber);
    const auto point = CGPointMake(bounds.origin.x + 320, bounds.origin.y + screen.frame.size.height - 240);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      @autoreleasepool {
        event("listening");
        const auto initial = line();
        NSData *raw = [NSData dataWithBytes:initial.data() length:initial.size()];
        NSDictionary *value = [NSJSONSerialization JSONObjectWithData:raw options:0 error:nullptr];
        require([value isKindOfClass:NSDictionary.class], "worker identity message");
        process_identity identity;
        identity.pid = [value[@"pid"] intValue]; identity.birth_sec = [value[@"birthSec"] unsignedLongLongValue];
        identity.birth_usec = [value[@"birthUsec"] unsignedIntValue];
        std::vector<std::string> catalog;
        for (NSDictionary *window in value[@"windows"]) {
          identity.windows.push_back({[window[@"id"] unsignedIntValue], [window[@"display"] unsignedIntValue]});
          catalog.push_back(std::to_string([window[@"display"] unsignedIntValue]));
        }
        require(valid(identity), "valid owned worker identity");
        const binding session {std::string(64, 'a'), std::string(32, 'b'), 1};
        displays.catalog(catalog); displays.add_stream(&client, session.owner, 1280, 720);
        const display_geometry geometry {std::to_string(display_id), 0, 0, 1920, 1080, 0, 0, 1920, 1080};
        auto generation = displays.begin_capture(geometry); displays.bind(&client, generation);
        displays.real_frame(&client, generation, 1); displays.encoded(&client, 1); // Only the initial registry state is simulated.
        auto wrong = identity; wrong.pid = getpid();
        require(prepare_native(session, wrong) != "accepted" && !native_state().retained, "foreign process rejected");
        wrong = identity; ++wrong.birth_sec;
        require(prepare_native(session, wrong) != "accepted" && !native_state().retained, "wrong process birth rejected");
        wrong = identity; wrong.windows[0].id = backdrop_id;
        require(prepare_native(session, wrong) != "accepted" && !native_state().retained, "foreign window rejected");
        wrong = identity; wrong.windows[0].display = UINT32_MAX;
        require(prepare_native(session, wrong) != "accepted" && !native_state().retained, "foreign display rejected");
        event("native-foreign-process-window-and-layout-rejected");
        const auto admitted = prepare_native(session, identity);
        if (admitted != "accepted") {
          const auto display = displays.snapshot();
          fprintf(stderr, "native admission outcome=%s supported=%d phase=%s streams=%zu generation=%llu\n", admitted.c_str(), native_supported(),
                  display.phase.c_str(), display.streams.size(), static_cast<unsigned long long>(display.generation));
          for (int pid = identity.pid, level = 0; pid > 1 && level < 3; ++level) {
            proc_bsdinfo info {}; const auto size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
            fprintf(stderr, "owned fixture ancestry level=%d pid=%d parent=%u uid=%u birth=%llu.%u query=%d\n", level, pid, info.pbi_ppid,
                    info.pbi_uid, static_cast<unsigned long long>(info.pbi_start_tvsec), static_cast<unsigned int>(info.pbi_start_tvusec), size);
            if (size != sizeof(info)) break;
            pid = info.pbi_ppid;
          }
          for (const auto &window : identity.windows) {
            const auto info = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window.id);
            fprintf(stderr, "owned fixture window=%u display=%u metadata=%s\n", window.id, window.display, [[(NSArray *)info description] UTF8String]);
            if (info) CFRelease(info);
          }
        }
        require(admitted == "accepted", "admit actual native mask windows");
        const auto epoch = native_state().epoch;
        require(native_state().authorized && !native_state().ready, "accepted filter is not encoded readiness");
        event("prepared");
        require(line() == "active", "mask activation message");
        AVVideo *owner = [[AVVideo alloc] initWithDisplay:display_id frameRate:60];
        require(owner != nil, "capture owner");
        auto local = [owner newCapture]; require(local != nil, "unfiltered capture starts");
        pixel(local, owner, point, false);
        std::uint64_t copied_epoch = 0;
        auto windows = copy_native_windows(copied_epoch);
        require(windows && windows.count == identity.windows.size() && copied_epoch == epoch, "exact filter snapshot");
        auto remote = [owner newCaptureExcludingWindows:windows]; [windows release];
        require(remote != nil, "filtered capture starts after local mask is visible");
        displays.invalidate(); generation = displays.begin_capture(geometry); displays.bind(&client, generation);
        native_source_started(epoch, generation);
        pixel(remote, owner, point, true); pixel(local, owner, point, false);
        require(native_source_current(epoch) && !native_state().ready, "pixels alone cannot claim encoded readiness");
        event("native-worker-mask-excluded-from-new-capture");
        require(release_native(session) == "worker_alive", "cannot remove filter before native worker death");
        require(native_state().retained && !native_state().authorized && native_source_current(epoch), "draining keeps exact exclusions");
        pixel(remote, owner, point, true);
        event("native-release-retains-filter-while-worker-lives");
        require(line() == "dead", "worker death message");
        auto state = native_state();
        require(!state.retained && state.epoch != epoch && !native_source_current(epoch), "original process death invalidates old source");
        windows = copy_native_windows(copied_epoch);
        require(windows && windows.count == 0 && copied_epoch == state.epoch, "new capture removes ended worker exclusions");
        auto restored = [owner newCaptureExcludingWindows:windows]; [windows release];
        require(restored && native_source_current(copied_epoch), "new unfiltered source after original worker death");
        pixel(restored, owner, point, true); stop(owner, restored);
        stop(owner, remote); stop(owner, local); [owner release];
        event("native-confirmed-death-removes-filter-and-reconstructs-source");
        dispatch_async(dispatch_get_main_queue(), ^{ [backdrop close]; exit(0); });
      }
    });
    [NSApp run];
  }
  return 1;
}
