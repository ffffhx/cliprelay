//go:build darwin && cgo

#import <Foundation/Foundation.h>
#import <SystemConfiguration/SystemConfiguration.h>
#include <stdlib.h>
#include <string.h>
#include "native_darwin.h"

char *cr_wake_interfaces(void) {
    @autoreleasepool {
        NSArray *interfaces = CFBridgingRelease(SCNetworkInterfaceCopyAll());
        if (!interfaces || interfaces.count > 256) return NULL;
        NSMutableArray *result = [NSMutableArray array];
        for (id object in interfaces) {
            SCNetworkInterfaceRef interface = (__bridge SCNetworkInterfaceRef)object;
            CFStringRef type = SCNetworkInterfaceGetInterfaceType(interface);
            NSString *kind = nil;
            if (type && CFEqual(type, kSCNetworkInterfaceTypeIEEE80211)) kind = @"wifi";
            else if (type && CFEqual(type, kSCNetworkInterfaceTypeEthernet)) kind = @"ethernet";
            if (!kind) continue;
            NSString *bsd = (__bridge NSString *)SCNetworkInterfaceGetBSDName(interface);
            NSString *mac = (__bridge NSString *)SCNetworkInterfaceGetHardwareAddressString(interface);
            NSString *name = (__bridge NSString *)SCNetworkInterfaceGetLocalizedDisplayName(interface);
            if (!bsd || !mac || bsd.length > 32 || mac.length > 32) continue;
            [result addObject:@{@"BSD":bsd, @"MAC":mac, @"Kind":kind, @"Name":name.length <= 128 ? (name ?: bsd) : bsd}];
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        if (!data || data.length > 65535) return NULL;
        char *output = malloc(data.length + 1);
        if (!output) return NULL;
        memcpy(output, data.bytes, data.length);
        output[data.length] = 0;
        return output;
    }
}
