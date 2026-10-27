// SPDX-License-Identifier: GPL-3.0-or-later
// Runs on macOS with the production Foundation/Security transport, without iOS hardware.
#import <Foundation/Foundation.h>
#import "CRTransport.h"
#import "CRPairingTicket.h"

static NSUInteger checks;
static void require(BOOL condition, const char *name) {
    if (!condition) { fprintf(stderr, "FAIL: %s\n", name); exit(1); }
    checks++;
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        require(argc == 2, "fixture argument");
        NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:@(argv[1])] options:0 error:nil];
        NSData *server = [NSData dataWithContentsOfFile:fixture[@"server"]];
        NSData *client = [NSData dataWithContentsOfFile:fixture[@"client"]];
        NSData *identity = [NSData dataWithContentsOfFile:fixture[@"pkcs12"]];
        NSError *error = nil;
        CRPairingTicket *ticket = [CRPairingTicket ticket:fixture[@"ticket"] server:server client:client nonce:fixture[@"nonce"] now:[fixture[@"now"] doubleValue] error:&error];
        require(ticket != nil && !error, "certificate-bound ticket");
        NSMutableDictionary *status = [@{@"protocol":@1, @"id":ticket.identifier, @"receipt":ticket.receipt,
            @"expires":@(ticket.expires), @"state":@"waiting"} mutableCopy];
        require([ticket observe:status error:&error], "waiting is observation only");
        status[@"state"] = @"handshake"; require([ticket observe:status error:&error], "handshake is observation only");
        for (NSString *terminal in @[@"rejected", @"expired", @"cancelled", @"approved", @"unknown"]) {
            status[@"state"] = terminal; require(![ticket observe:status error:&error], "terminal or invented status rejected");
        }
        status[@"state"] = @"waiting"; status[@"receipt"] = @"ffffffffffffffffffffffffffffffff";
        require(![ticket observe:status error:&error], "stale receipt rejected");
        status[@"receipt"] = ticket.receipt; status[@"expires"] = @(ticket.expires + 1);
        require(![ticket observe:status error:&error], "extended expiry rejected");
        status[@"expires"] = @(ticket.expires); status[@"protocol"] = @YES;
        require(![ticket observe:status error:&error], "boolean protocol rejected");
        require(![CRPairingTicket ticket:fixture[@"ticket"] server:client client:server nonce:fixture[@"nonce"] now:[fixture[@"now"] doubleValue] error:&error], "certificate substitution rejected");
        require(![CRPairingTicket ticket:fixture[@"ticket"] server:server client:client nonce:fixture[@"nonce"] now:ticket.expires + 1 error:&error], "expired ticket rejected");

        CRTransport *transport = [[CRTransport alloc] initWithHost:@"127.0.0.1" port:[fixture[@"port"] unsignedIntegerValue] certificate:nil pkcs12:identity error:&error];
        require(transport != nil, "client identity import");
        CRTransport *ipv6 = [[CRTransport alloc] initWithHost:@"::1" port:48789 certificate:server pkcs12:identity error:&error];
        require([[[ipv6 URLForPath:@"/v1/pair" offset:3] absoluteString] isEqual:@"https://[::1]:48792/v1/pair"], "IPv6 endpoint formatting");
        [ipv6 cancel];
        NSDictionary *(^json)(NSString *, BOOL, NSUInteger, NSError **) = ^(NSString *path, BOOL bootstrap, NSUInteger limit, NSError **failure) {
            return [transport JSON:path offset:3 method:@"POST" body:@{} headers:@{} bootstrap:bootstrap timeout:2 limit:limit error:failure];
        };
        require(json(@"/ok", NO, 2048, &error) == nil, "unpinned normal request refused");
        require(json(@"/ok", YES, 2048, &error) == nil, "bootstrap limited to pairing");
        require(json(@"/v1/pair", YES, 2048, &error) != nil, "mutual TLS bootstrap");
        require([transport.serverCertificate isEqual:server], "bootstrap records exact DER");
        require(json(@"/ok", NO, 2048, &error) != nil, "pinned mutual TLS request");
        require([transport JSON:@"/ok" offset:2 method:@"POST" body:@{} headers:@{} bootstrap:NO timeout:2 limit:2048 error:&error] == nil, "changed certificate rejected before HTTP");
        require(json(@"/redirect", NO, 2048, &error) == nil, "redirect refused");
        require(json(@"/large", NO, 2048, &error) == nil, "response bound");
        require(json(@"/chunked", NO, 2048, &error) == nil, "streamed response bound");
        require(json(@"/invalid", NO, 2048, &error) == nil, "non-object JSON rejected");
        require(json(@"/revoked", NO, 2048, &error) == nil, "revocation rejected");
        CRTransport *fresh = [transport freshTransport];
        require([fresh.serverCertificate isEqual:server], "cleanup transport retains pin");
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 5), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ [transport cancel]; });
        NSTimeInterval before = NSProcessInfo.processInfo.systemUptime;
        require(json(@"/slow", NO, 2048, &error) == nil && NSProcessInfo.processInfo.systemUptime - before < 1.5, "cancel interrupts pending read");
        require(json(@"/ok", NO, 2048, &error) == nil, "cancel is permanent");
        require([fresh JSON:@"/v1/pair/cleanup" offset:3 method:@"DELETE" body:nil headers:@{} bootstrap:NO timeout:2 limit:2048 error:&error] != nil, "pinned cleanup after cancellation");
        [fresh cancel];
        printf("{\"passed\":true,\"checks\":%lu,\"physicalDeviceAccepted\":false}\n", (unsigned long)checks);
    }
    return 0;
}
