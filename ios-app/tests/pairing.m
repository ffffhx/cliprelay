// SPDX-License-Identifier: GPL-3.0-or-later
// Production PairManager/CryptoManager/HttpManager with a synthetic peer, no UIKit.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import "PairManager.h"
#import "CryptoManager.h"
#import "Utils.h"

// Launch negotiation is not exercised by this protocol-only executable.
const char *LiGetLaunchUrlQueryParameters(void) { return ""; }

@interface PairingProbe : NSObject <PairCallback>
@property(nonatomic, strong) PairManager *operation;
@property(nonatomic, copy) NSString *mode;
@property(nonatomic, copy) NSData *expected;
@property BOOL done;
@property BOOL success;
@property BOOL verified;
@end
@implementation PairingProbe
- (BOOL)isCurrentPairing:(PairManager *)operation { return operation == self.operation; }
- (void)startPairing:(NSString *)message { }
- (void)updatePairingCode:(NSString *)code {
    self.verified = code.length == 14;
    if ([self.mode isEqual:@"cancel"]) [self.operation cancel];
}
- (void)pairSuccessful:(NSData *)certificate {
    self.done = YES; self.success = self.verified && [certificate isEqual:self.expected];
}
- (void)pairFailed:(NSString *)message { self.done = YES; self.success = NO; }
- (void)alreadyPaired { abort(); }
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 3) return 2;
        NSString *mode = @(argv[1]), *directory = @(argv[2]);
        [CryptoManager generateKeyPairUsingSSL];
        if (![CryptoManager readP12FromFile]) { fprintf(stderr, "Fixture identity unavailable\n"); return 3; }
        if ([mode isEqual:@"identity"]) {
            [[CryptoManager readCertFromFile] writeToFile:[directory stringByAppendingPathComponent:@"client.crt"] atomically:YES];
            [[CryptoManager readKeyFromFile] writeToFile:[directory stringByAppendingPathComponent:@"client.key"] atomically:YES];
            return 0;
        }
        if ([mode isEqual:@"cleanup"]) {
            NSDictionary *query = @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
                (__bridge id)kSecAttrService:[NSBundle.mainBundle.bundleIdentifier stringByAppendingString:@".pairing-identity"],
                (__bridge id)kSecAttrAccount:@"controller-v1"};
            return SecItemDelete((__bridge CFDictionaryRef)query) == errSecSuccess ? 0 : 4;
        }
        if (argc != 4) return 2;
        PairingProbe *probe = [[PairingProbe alloc] init]; probe.mode = mode;
        probe.expected = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"server.der"]];
        HttpManager *http = [[HttpManager alloc] initWithAddress:@(argv[3]) httpsPort:0 serverCert:nil];
        probe.operation = [[PairManager alloc] initWithManager:http clientCert:[CryptoManager readCertFromFile] callback:probe];
        NSOperationQueue *queue = [[NSOperationQueue alloc] init]; [queue addOperation:probe.operation];
        NSTimeInterval until = NSProcessInfo.processInfo.systemUptime + 20;
        while (!probe.done && NSProcessInfo.processInfo.systemUptime < until) {
            if ([mode isEqual:@"cancel"] && probe.operation.finished) break;
            [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        }
        [queue waitUntilAllOperationsAreFinished];
        BOOL passed = [mode isEqual:@"good"] ? probe.done && probe.success :
            [mode isEqual:@"cancel"] ? probe.operation.cancelled && !probe.done && probe.verified : probe.done && !probe.success;
        printf("{\"passed\":%s,\"verified\":%s}\n", passed ? "true" : "false", probe.verified ? "true" : "false");
        return passed ? 0 : 1;
    }
}
