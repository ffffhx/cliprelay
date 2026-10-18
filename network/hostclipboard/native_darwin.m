//go:build darwin && cgo

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ImageIO/ImageIO.h>
#include <unistd.h>
#include "native_darwin.h"

enum { OK = 0, EMPTY = 1, LOCKED = 2, TOO_LARGE = 3, UNAVAILABLE = 4, PERMISSION_REQUIRED = 5, CHANGED = 6 };
static const NSUInteger textLimit = 1024 * 1024, imageLimit = 8 * 1024 * 1024;

int cr_clipboard_available(void) {
    @autoreleasepool {
        NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
        if (!session || ![session[(id)kCGSessionOnConsoleKey] boolValue] ||
            ![session[(id)kCGSessionLoginDoneKey] boolValue] ||
            ![session[(id)kCGSessionUserIDKey] isKindOfClass:[NSNumber class]] ||
            [session[(id)kCGSessionUserIDKey] unsignedIntValue] != geteuid() ||
            [session[@"CGSSessionScreenIsLocked"] boolValue]) return LOCKED;
        return OK;
    }
}

static NSPasteboard *board(const char *name) {
    return name && name[0] ? [NSPasteboard pasteboardWithName:[NSString stringWithUTF8String:name]] : [NSPasteboard generalPasteboard];
}

static int readPermission(NSPasteboard *pasteboard) {
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 150400
    if (@available(macOS 15.4, *)) {
        if (pasteboard.accessBehavior == NSPasteboardAccessBehaviorAlwaysDeny) return PERMISSION_REQUIRED;
    }
#endif
    return OK;
}

static int copyData(NSData *value, NSUInteger limit, void **data, size_t *length) {
    if (!value) return UNAVAILABLE;
    if (!value.length) return EMPTY;
    if (value.length > limit) return TOO_LARGE;
    *data = malloc(value.length);
    if (!*data) return UNAVAILABLE;
    memcpy(*data, value.bytes, value.length);
    *length = value.length;
    return OK;
}

// Explicit image data only: never resolve file URLs, promised files or objects
// that would cause AppKit to load an arbitrary local path as an image.
static int pngData(NSData *value, NSData **png) {
    if (!value || !value.length) return UNAVAILABLE;
    if (value.length > imageLimit) return TOO_LARGE;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)value, (__bridge CFDictionaryRef)@{(id)kCGImageSourceShouldCache:@NO});
    if (!source) return UNAVAILABLE;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    uint64_t width = [properties[(id)kCGImagePropertyPixelWidth] unsignedLongLongValue];
    uint64_t height = [properties[(id)kCGImagePropertyPixelHeight] unsignedLongLongValue];
    if (!width || !height || width > 4096 || height > 4096 || width * height > 6000000) { CFRelease(source); return TOO_LARGE; }
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, (__bridge CFDictionaryRef)@{(id)kCGImageSourceShouldCacheImmediately:@YES});
    CFRelease(source);
    if (!image) return UNAVAILABLE;
    NSMutableData *output = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)output, CFSTR("public.png"), 1, NULL);
    if (!destination) { CGImageRelease(image); return UNAVAILABLE; }
    CGImageDestinationAddImage(destination, image, NULL);
    bool completed = CGImageDestinationFinalize(destination);
    CFRelease(destination);
    CGImageRelease(image);
    if (!completed) return UNAVAILABLE;
    if (output.length > imageLimit) return TOO_LARGE;
    *png = output;
    return OK;
}

int cr_clipboard_read(const char *name, int *kind, void **data, size_t *length) {
    @autoreleasepool { @try {
        *data = NULL; *length = 0; *kind = 0;
        int available = cr_clipboard_available(); if (available) return available;
        NSPasteboard *pasteboard = board(name);
        int permission = readPermission(pasteboard); if (permission) return permission;
        NSInteger generation = pasteboard.changeCount;
        NSArray *types = pasteboard.types;
        NSData *value = nil;
        NSUInteger limit = textLimit;
        if ([types containsObject:NSPasteboardTypePNG] || [types containsObject:NSPasteboardTypeTIFF]) {
            NSString *type = [types containsObject:NSPasteboardTypePNG] ? NSPasteboardTypePNG : NSPasteboardTypeTIFF;
            int result = pngData([pasteboard dataForType:type], &value);
            if (result) return readPermission(pasteboard) ?: result;
            *kind = 2; limit = imageLimit;
        } else if ([types containsObject:NSPasteboardTypeString]) {
            // Read the explicit UTF-8 representation without concatenating all
            // pasteboard items or resolving other representations.
            value = [pasteboard dataForType:NSPasteboardTypeString]; *kind = 1;
        } else return readPermission(pasteboard) ?: EMPTY;
        available = cr_clipboard_available(); if (available) return available;
        if (pasteboard.changeCount != generation) return UNAVAILABLE;
        return copyData(value, limit, data, length);
    } @catch (NSException *exception) { return UNAVAILABLE; } }
}

int cr_clipboard_version(const char *name, long long *version) {
    @autoreleasepool { @try {
        int available = cr_clipboard_available(); if (available) return available;
        NSInteger count = board(name).changeCount;
        if (count < 0) return UNAVAILABLE;
        *version = count;
        return OK;
    } @catch (NSException *exception) { return UNAVAILABLE; } }
}

int cr_clipboard_write(const char *name, int kind, const void *data, size_t length) {
    return cr_clipboard_write_if_version(name, kind, data, length, -1);
}

int cr_clipboard_write_if_version(const char *name, int kind, const void *data, size_t length, long long version) {
    @autoreleasepool { @try {
        if (!data || !length || (kind != 1 && kind != 2)) return UNAVAILABLE;
        if (length > (kind == 1 ? textLimit : imageLimit)) return TOO_LARGE;
        NSData *value = [NSData dataWithBytes:data length:length];
        NSPasteboardItem *item = [NSPasteboardItem new];
        if (kind == 1) {
            NSString *text = [[NSString alloc] initWithData:value encoding:NSUTF8StringEncoding];
            if (!text || ![item setString:text forType:NSPasteboardTypeString]) return UNAVAILABLE;
        } else if (![item setData:value forType:NSPasteboardTypePNG]) return UNAVAILABLE;
        int available = cr_clipboard_available(); if (available) return available;
        NSPasteboard *pasteboard = board(name);
        // AppKit provides no atomic compare-and-replace operation. Check after
        // preparing the payload, immediately before declaring the new contents.
        if (version >= 0 && pasteboard.changeCount != version) return CHANGED;
        [pasteboard clearContents];
        return [pasteboard writeObjects:@[item]] ? OK : UNAVAILABLE;
    } @catch (NSException *exception) { return UNAVAILABLE; } }
}
