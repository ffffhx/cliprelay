// SPDX-License-Identifier: GPL-3.0-or-later
#import "CRPairingTicket.h"
#import "CRTransport.h"
#import <CommonCrypto/CommonDigest.h>

static BOOL keys(NSDictionary *value, NSArray *expected) {
    return [value isKindOfClass:NSDictionary.class] &&
        [[NSSet setWithArray:value.allKeys] isEqual:[NSSet setWithArray:expected]];
}
static BOOL hexID(id value) {
    return [value isKindOfClass:NSString.class] && [value length] == 32 &&
        [value rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"].invertedSet].location == NSNotFound;
}
static BOOL integer(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
        [value doubleValue] == [value longLongValue];
}
@implementation CRPairingTicket
+ (instancetype)ticket:(NSDictionary *)value server:(NSData *)server client:(NSData *)client
                 nonce:(NSString *)nonce now:(NSTimeInterval)now error:(NSError **)error {
    NSDictionary *feedback = [value isKindOfClass:NSDictionary.class] ? value[@"feedback"] : nil;
    NSDictionary *native = [value isKindOfClass:NSDictionary.class] ? value[@"native"] : nil;
    if (!server.length || !client.length || !hexID(nonce) || ![value isKindOfClass:NSDictionary.class] ||
        !keys(feedback, @[@"protocol", @"receipt"]) || !integer(feedback[@"protocol"]) || [feedback[@"protocol"] intValue] != 1 ||
        !hexID(feedback[@"receipt"]) || !keys(native, @[@"protocol", @"id"]) ||
        !integer(native[@"protocol"]) || [native[@"protocol"] intValue] != 1 || !hexID(native[@"id"]) ||
        !integer(value[@"expires"]) || [value[@"expires"] longLongValue] <= now || [value[@"expires"] longLongValue] > now + 180) {
        if (error) *error = CRError(@"电脑配对信息无效或已过期。请更新电脑端并检查两端时间。");
        return nil;
    }
    NSMutableData *input = [[@"cliprelay-lan-pair-v1\n" dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    [input appendData:server]; [input appendData:client]; [input appendData:[nonce dataUsingEncoding:NSUTF8StringEncoding]];
    unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(input.bytes, (CC_LONG)input.length, hash);
    NSMutableString *digest = [NSMutableString string];
    for (NSUInteger i = 0; i < sizeof(hash); i++) [digest appendFormat:@"%02x", hash[i]];
    NSString *identifier = [digest substringToIndex:32];
    NSString *verification = [[NSString stringWithFormat:@"%@ %@ %@", [digest substringWithRange:NSMakeRange(0, 4)],
        [digest substringWithRange:NSMakeRange(4, 4)], [digest substringWithRange:NSMakeRange(8, 4)]] uppercaseString];
    if (![identifier isEqual:value[@"id"]] || ![verification isEqual:value[@"verification"]]) {
        if (error) *error = CRError(@"两端配对标识不匹配，已停止连接。");
        return nil;
    }
    CRPairingTicket *ticket = [[self alloc] init];
    ticket->_identifier = identifier; ticket->_verification = verification;
    ticket->_receipt = feedback[@"receipt"]; ticket->_nativeIdentifier = native[@"id"];
    ticket->_expires = [value[@"expires"] longLongValue];
    return ticket;
}
- (BOOL)observe:(NSDictionary *)value error:(NSError **)error {
    if (!keys(value, @[@"protocol", @"id", @"receipt", @"expires", @"state"]) ||
        !integer(value[@"protocol"]) || [value[@"protocol"] intValue] != 1 ||
        ![self.identifier isEqual:value[@"id"]] || ![self.receipt isEqual:value[@"receipt"]] ||
        !integer(value[@"expires"]) || [value[@"expires"] longLongValue] != self.expires ||
        ![@[@"waiting", @"approving", @"handshake", @"rejected", @"expired", @"cancelled"] containsObject:value[@"state"] ?: @""]) {
        if (error) *error = CRError(@"配对状态无法验证，已停止连接。");
        return NO;
    }
    NSDictionary *terminal = @{@"rejected":@"电脑拒绝了配对请求。", @"expired":@"配对已超时，请重新发起。", @"cancelled":@"电脑取消了配对请求。"};
    NSString *message = terminal[value[@"state"]];
    if (message) { if (error) *error = CRError(message); return NO; }
    return YES;
}
@end
