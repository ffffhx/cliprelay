#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#include <unistd.h>

int main(void) {
    @autoreleasepool {
        if (!AXIsProcessTrusted()) return 2;
        CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        if (!source) return 3;
        // Physical macOS key code 8 is C. Match hs.eventtap.keyStroke({"cmd"},"c").
        CGEventRef down = CGEventCreateKeyboardEvent(source, 8, true);
        CGEventRef up = CGEventCreateKeyboardEvent(source, 8, false);
        if (!down || !up) return 3;
        CGEventSetFlags(down, kCGEventFlagMaskCommand);
        CGEventSetFlags(up, kCGEventFlagMaskCommand);
        CGEventPost(kCGHIDEventTap, down);
        usleep(200000); // hs.eventtap.keyStroke's default key-down duration.
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(down); CFRelease(up); CFRelease(source);
    }
    return 0;
}
