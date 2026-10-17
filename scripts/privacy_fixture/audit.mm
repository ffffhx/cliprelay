// Inspect only the named CI worker's window metadata; no titles or pixels.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <unistd.h>
int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 2 || !getenv("GITHUB_ACTIONS") || strcmp(getenv("GITHUB_ACTIONS"), "true")) return 2;
    char *end = nullptr;
    long pid = strtol(argv[1], &end, 10);
    if (*end || pid <= 1) return 2;
    NSArray *all = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
    if (!all) return 1;
    NSMutableArray *owned = [NSMutableArray array];
    for (NSDictionary *window in all) {
      if ([window[(id)kCGWindowOwnerPID] longValue] != pid) continue;
      [owned addObject:@{@"id":window[(id)kCGWindowNumber], @"pid":@(pid),
        @"alpha":window[(id)kCGWindowAlpha] ?: @0, @"onScreen":window[(id)kCGWindowIsOnscreen] ?: @NO}];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:owned options:0 error:nullptr];
    if (!data) return 1;
    fwrite(data.bytes, 1, data.length, stdout);
    return 0;
  }
}
