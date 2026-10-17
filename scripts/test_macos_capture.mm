// SPDX-License-Identifier: GPL-3.0-only
// Disposable macOS CI only: inspect fixture-owned pixels through the production
// capture source. No frame is saved and no real input or clipboard is touched.
#import <AppKit/AppKit.h>
#import "av_video.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <unistd.h>

static void require(bool condition, const char *what) {
  if (!condition) {
    fprintf(stderr, "capture verification failed: %s\n", what);
    fflush(stderr);
    exit(1);
  }
}
static SCShareableContent *content() {
  auto ready = dispatch_semaphore_create(0);
  __block SCShareableContent *result = nil;
  [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *value, NSError *error) {
    if (!error) result = [value retain];
    dispatch_semaphore_signal(ready);
  }];
  require(dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0, "shareable content deadline");
  dispatch_release(ready);
  require(result != nil, "shareable content access");
  return [result autorelease];
}
static SCWindow *findWindow(CGWindowID identifier) {
  for (SCWindow *window in content().windows) {
    if (window.windowID == identifier && window.owningApplication.processID == getpid()) return window;
  }
  return nil;
}
static void pixel(AVVideoFrameSource *source, AVVideo *owner, CGPoint point, bool red) {
  auto until = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  bool matched = false;
  while (std::chrono::steady_clock::now() < until) {
    auto sample = [source copyNextFrameBefore:dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC)];
    if (!sample) continue;
    auto buffer = CMSampleBufferGetImageBuffer(sample);
    require(CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA, "BGRA pixel format");
    CGRect bounds = CGDisplayBounds(owner.displayID);
    auto width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer);
    size_t x = (point.x - bounds.origin.x) * width / bounds.size.width;
    size_t y = (point.y - bounds.origin.y) * height / bounds.size.height;
    require(x < width && y < height, "fixture point inside native capture");
    require(CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess, "pixel map");
    const auto *p = static_cast<unsigned char *>(CVPixelBufferGetBaseAddress(buffer)) + y * CVPixelBufferGetBytesPerRow(buffer) + x * 4;
    matched = red ? (p[2] > 180 && p[1] < 60 && p[0] < 60) : (p[0] < 20 && p[1] < 20 && p[2] < 20);
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    CFRelease(sample);
    if (matched) break;
  }
  require(matched, red ? "real captured underlying red fixture" : "real captured local black mask");
}
static void closeSource(AVVideo *owner, AVVideoFrameSource *source) {
  [owner stopCapture:source];
  require([source copyNextFrameBefore:DISPATCH_TIME_NOW] == nullptr, "stopped source has no retained frame");
  [source release];
}

int main() {
  @autoreleasepool {
    require(getenv("GITHUB_ACTIONS") && !strcmp(getenv("GITHUB_ACTIONS"), "true"), "disposable CI only");
    require(CGPreflightScreenCaptureAccess(), "pre-existing CI screen capture permission");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSScreen *screen = NSScreen.mainScreen;
    require(screen != nil, "native display");
    NSRect rect = NSMakeRect(screen.frame.origin.x + 80, screen.frame.origin.y + 80, 480, 320);
    auto backdrop = [[NSWindow alloc] initWithContentRect:rect styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    backdrop.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1];
    backdrop.opaque = YES;
    backdrop.hasShadow = NO;
    backdrop.level = NSFloatingWindowLevel;
    [backdrop orderFrontRegardless];
    auto mask = [[NSWindow alloc] initWithContentRect:rect styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    mask.backgroundColor = NSColor.blackColor;
    mask.opaque = YES;
    mask.hasShadow = NO;
    mask.level = NSFloatingWindowLevel + 1;
    mask.alphaValue = 0;
    [mask orderFrontRegardless];
    CGDirectDisplayID displayID = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
    CGWindowID maskID = (CGWindowID)mask.windowNumber;
    CGRect bounds = CGDisplayBounds(displayID);
    CGPoint point = CGPointMake(bounds.origin.x + 320, bounds.origin.y + screen.frame.size.height - 240);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      @autoreleasepool {
        SCWindow *transparentMask = findWindow(maskID);
        printf("transparentMaskDiscoverable=%s\n", transparentMask ? "true" : "false");
        dispatch_sync(dispatch_get_main_queue(), ^{ mask.alphaValue = 1; });
        SCWindow *nativeMask = findWindow(maskID);
        require(nativeMask != nil, "owned mask discoverable");
        AVVideo *owner = [[AVVideo alloc] initWithDisplay:displayID frameRate:60];
        require(owner != nil, "native capture owner");
        auto local = [owner newCapture];
        require(local != nil, "native ordinary capture starts");
        pixel(local, owner, point, false);
        auto remote = [owner newCaptureExcludingWindows:@[nativeMask]];
        require(remote != nil, "native filtered capture starts");
        pixel(remote, owner, point, true);
        // Read both again: starting an excluded source cannot modify the other.
        pixel(local, owner, point, false);
        pixel(remote, owner, point, true);
        puts("PASS native-owned-mask-exclusion-and-source-isolation");
        // A static display must keep producing real current images across the
        // production three-second stall boundary, without restarting capture.
        auto until = std::chrono::steady_clock::now() + std::chrono::seconds(8);
        auto last = std::chrono::steady_clock::now();
        size_t samples = 0;
        while (std::chrono::steady_clock::now() < until) {
          auto sample = [remote copyNextFrameBefore:dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC)];
          if (sample) { ++samples; CFRelease(sample); last = std::chrono::steady_clock::now(); }
          require(std::chrono::steady_clock::now() - last < std::chrono::seconds(2), "static desktop fresh image continuity");
        }
        require(samples >= 8, "multiple independently captured static images");
        printf("PASS native-static-desktop-current-images samples=%zu\n", samples);
        closeSource(owner, remote);
        dispatch_sync(dispatch_get_main_queue(), ^{ [mask orderOut:nil]; });
        pixel(local, owner, point, true);
        closeSource(owner, local);
        puts("PASS native-mask-removal-restores-unfiltered-image");
        for (auto format : {kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange}) {
          owner.pixelFormat = format;
          auto source = [owner newCapture];
          require(source != nil, "native encoder pixel format starts");
          auto sample = [source copyNextFrameBefore:dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)];
          require(sample != nullptr, "native encoder pixel format frame");
          auto buffer = CMSampleBufferGetImageBuffer(sample);
          require(CVPixelBufferGetPixelFormatType(buffer) == format && CVPixelBufferGetPlaneCount(buffer) == 2, "native NV12/P010 planes");
          require(CVPixelBufferGetWidth(buffer) == (size_t)owner.frameWidth && CVPixelBufferGetHeight(buffer) == (size_t)owner.frameHeight, "native frame geometry");
          CFRelease(sample);
          closeSource(owner, source);
        }
        puts("PASS native-NV12-P010-geometry");
        [owner release];
        fflush(stdout);
        dispatch_async(dispatch_get_main_queue(), ^{ [mask close]; [backdrop close]; exit(0); });
      }
    });
    [NSApp run];
  }
  return 1;
}
