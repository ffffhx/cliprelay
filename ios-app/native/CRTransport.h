// SPDX-License-Identifier: GPL-3.0-or-later
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
FOUNDATION_EXPORT NSError *CRError(NSString *message);

@interface CRHTTPResult : NSObject
@property NSInteger status;
@property(copy) NSData *data;
@end

// One owner, one endpoint and one certificate pin. Cancellation is permanent.
// Only an explicitly requested pairing bootstrap may establish a new pin.
@interface CRTransport : NSObject
@property(atomic, copy, readonly, nullable) NSData *serverCertificate;
@property(nonatomic, copy, readonly) NSString *host;
@property(nonatomic, readonly) NSUInteger port;
- (nullable instancetype)initWithHost:(NSString *)host port:(NSUInteger)port
                        certificate:(nullable NSData *)certificate
                             pkcs12:(NSData *)pkcs12 error:(NSError **)error;
- (NSURL *)URLForPath:(NSString *)path offset:(NSInteger)offset;
- (nullable CRHTTPResult *)perform:(NSURLRequest *)request bootstrap:(BOOL)bootstrap
                            limit:(NSUInteger)limit error:(NSError **)error;
- (nullable NSDictionary *)JSON:(NSString *)path offset:(NSInteger)offset method:(NSString *)method
                          body:(nullable NSDictionary *)body headers:(NSDictionary *)headers
                     bootstrap:(BOOL)bootstrap timeout:(NSTimeInterval)timeout
                         limit:(NSUInteger)limit error:(NSError **)error;
- (nullable CRTransport *)freshTransport;
- (void)cancel;
@end
NS_ASSUME_NONNULL_END
