// SPDX-License-Identifier: GPL-3.0-or-later
#import <Foundation/Foundation.h>

@interface CRPairingTicket : NSObject
@property(nonatomic, copy, readonly) NSString *identifier;
@property(nonatomic, copy, readonly) NSString *receipt;
@property(nonatomic, copy, readonly) NSString *nativeIdentifier;
@property(nonatomic, copy, readonly) NSString *verification;
@property(nonatomic, readonly) int64_t expires;
+ (instancetype)ticket:(NSDictionary *)value server:(NSData *)server client:(NSData *)client
                 nonce:(NSString *)nonce now:(NSTimeInterval)now error:(NSError **)error;
- (BOOL)observe:(NSDictionary *)value error:(NSError **)error;
@end
