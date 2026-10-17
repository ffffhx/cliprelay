// SPDX-License-Identifier: GPL-3.0-only
#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "native_darwin.h"

// Every AppKit object below belongs to the initial OS thread. The Go process
// watchdog is independent of this queue and can terminate a stuck window loop.
static NSMutableArray<NSWindow *> *masks;
static NSArray<NSDictionary *> *screenLayout;
static EventHotKeyRef escapeKey;
static EventHandlerRef escapeHandler;
static id screenObserver;
static BOOL prepared;
static BOOL active;

static void on_main(void (^work)(void)) {
  if (NSThread.isMainThread) work();
  else dispatch_sync(dispatch_get_main_queue(), work);
}

static NSArray<NSDictionary *> *layout(void) {
  NSArray<NSScreen *> *screens = NSScreen.screens;
  if (!screens.count || screens.count > 16) return nil;
  NSMutableArray *result = [NSMutableArray array];
  NSMutableSet *identifiers = [NSMutableSet set];
  for (NSScreen *screen in screens) {
    NSNumber *identifier = screen.deviceDescription[@"NSScreenNumber"];
    if (!identifier.unsignedIntValue || [identifiers containsObject:identifier] || NSIsEmptyRect(screen.frame)) return nil;
    [identifiers addObject:identifier];
    [result addObject:@{@"display":identifier, @"frame":[NSValue valueWithRect:screen.frame]}];
  }
  return result;
}

static void hide(void) {
  for (NSWindow *window in masks) {
    window.alphaValue = 0;
    [window orderOut:nil];
  }
  active = NO;
  prepared = NO;
  if (escapeKey) { UnregisterEventHotKey(escapeKey); escapeKey = NULL; }
}

static OSStatus escape_pressed(EventHandlerCallRef next, EventRef event, void *context) {
  EventHotKeyID key;
  if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(key), NULL, &key) == noErr &&
      key.signature == 'CRpv' && key.id == 1) {
    hide();
    // Terminating this private worker withdraws the lease even if its host is
    // blocked. macOS removes the worker's windows on process exit as well.
    exit(0);
  }
  return eventNotHandledErr;
}

int cr_privacy_bootstrap(void) {
  if (!NSThread.isMainThread) return 0;
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    masks = [NSMutableArray array];
    EventTypeSpec type = {kEventClassKeyboard, kEventHotKeyPressed};
    if (InstallApplicationEventHandler(escape_pressed, 1, &type, NULL, &escapeHandler) != noErr) return 0;
    screenObserver = [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
      if (prepared || active) { hide(); exit(3); }
    }];
    return 1;
  }
}

void cr_privacy_run(void) {
  @autoreleasepool {
    [NSApp run];
    hide();
    for (NSWindow *window in masks) [window close];
    [masks removeAllObjects];
    [NSNotificationCenter.defaultCenter removeObserver:screenObserver];
    if (escapeHandler) { RemoveEventHandler(escapeHandler); escapeHandler = NULL; }
  }
}

void cr_privacy_finish(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    hide();
    [NSApp stop:nil];
    // Wake run even when no windows or input events are pending.
    [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:YES];
  });
}

char *cr_privacy_prepare(void) {
  __block char *result = NULL;
  on_main(^{
    @autoreleasepool {
      if (active || prepared) return;
      NSArray *fresh = layout();
      if (!fresh) return;
      EventHotKeyID identifier = {'CRpv', 1};
      // The OS rejects an occupied shortcut; never steal an existing binding.
      if (RegisterEventHotKey(kVK_Escape, controlKey | optionKey | cmdKey, identifier, GetApplicationEventTarget(), 0, &escapeKey) != noErr) return;
      if (![fresh isEqualToArray:screenLayout]) {
        for (NSWindow *window in masks) [window close];
        [masks removeAllObjects];
        for (NSDictionary *screen in fresh) {
          NSRect frame = [screen[@"frame"] rectValue];
          NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
          window.releasedWhenClosed = NO;
          window.backgroundColor = NSColor.blackColor;
          window.opaque = YES;
          window.hasShadow = NO;
          window.ignoresMouseEvents = YES;
          window.level = NSScreenSaverWindowLevel;
          window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary;
          window.alphaValue = 0;
          NSTextField *hint = [NSTextField labelWithString:@"ClipRelay 隐私屏\n按 Control + Option + Command + Esc 退出"];
          hint.textColor = NSColor.grayColor;
          hint.alignment = NSTextAlignmentCenter;
          hint.frame = NSMakeRect(20, 20, MAX(0, frame.size.width - 40), 48);
          [window.contentView addSubview:hint];
          [masks addObject:window];
        }
        screenLayout = fresh;
      }
      struct proc_bsdinfo info = {0};
      if (proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_pid != getpid()) { hide(); return; }
      NSMutableArray *windows = [NSMutableArray array];
      for (NSUInteger i = 0; i < masks.count; ++i) {
        NSWindow *window = masks[i];
        window.alphaValue = 0;
        [window orderFrontRegardless];
        if (window.windowNumber <= 0) { hide(); return; }
        [windows addObject:@{@"id":@(window.windowNumber), @"display":screenLayout[i][@"display"]}];
      }
      NSDictionary *identity = @{@"pid":@(getpid()), @"birthSec":@(info.pbi_start_tvsec), @"birthUsec":@(info.pbi_start_tvusec), @"windows":windows};
      NSData *data = [NSJSONSerialization dataWithJSONObject:identity options:0 error:nil];
      if (!data || data.length > 4096) { hide(); return; }
      result = strndup(data.bytes, data.length);
      prepared = result != NULL;
      if (!prepared) hide();
    }
  });
  return result;
}

int cr_privacy_show(void) {
  __block int result = 0;
  on_main(^{
    if (!prepared || !escapeKey || ![layout() isEqualToArray:screenLayout]) return;
    for (NSWindow *window in masks) { [window orderFrontRegardless]; window.alphaValue = 1; }
    active = YES;
    result = 1;
  });
  return result;
}

int cr_privacy_healthy(void) {
  __block int result = 0;
  on_main(^{
    if (!active || !prepared || !escapeKey || ![layout() isEqualToArray:screenLayout]) return;
    for (NSUInteger i = 0; i < masks.count; ++i) {
      NSWindow *window = masks[i];
      if (!window.visible || window.alphaValue != 1 || !NSEqualRects(window.frame, [screenLayout[i][@"frame"] rectValue])) return;
    }
    result = 1;
  });
  return result;
}

int cr_privacy_hide(void) {
  on_main(^{ hide(); });
  return 1;
}
