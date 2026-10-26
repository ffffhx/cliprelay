// SPDX-License-Identifier: GPL-3.0-or-later
#import "CRTransport.h"
#import <Security/Security.h>
#include <arpa/inet.h>

NSError *CRError(NSString *message) {
    return [NSError errorWithDomain:@"ClipRelay" code:1 userInfo:@{NSLocalizedDescriptionKey:message}];
}
@implementation CRHTTPResult
@end

@interface CRTransport ()
@property(atomic, copy, readwrite) NSData *serverCertificate;
@property(nonatomic, copy, readwrite) NSString *host;
@property(nonatomic, readwrite) NSUInteger port;
@property NSData *identityData;
@property NSURLCredential *credential;
@property NSMutableSet<NSURLSession *> *sessions;
@property BOOL cancelled;
- (BOOL)acceptCertificate:(NSData *)certificate bootstrap:(BOOL)bootstrap;
@end

@interface CRHTTPExchange : NSObject <NSURLSessionDataDelegate>
@property CRTransport *owner;
@property BOOL bootstrap;
@property BOOL verifiedPeer;
@property NSUInteger limit;
@property NSMutableData *bytes;
@property NSInteger status;
@property NSError *error;
@property dispatch_semaphore_t finished;
@end

@implementation CRHTTPExchange
- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
 completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completion {
    NSString *method = challenge.protectionSpace.authenticationMethod;
    if ([method isEqual:NSURLAuthenticationMethodServerTrust]) {
        SecTrustRef trust = challenge.protectionSpace.serverTrust;
        NSData *der = nil;
        if (trust && SecTrustGetCertificateCount(trust) == 1) {
            SecCertificateRef certificate = SecTrustGetCertificateAtIndex(trust, 0);
            if (certificate) der = CFBridgingRelease(SecCertificateCopyData(certificate));
        }
        if (der.length && der.length <= 16384 && [self.owner acceptCertificate:der bootstrap:self.bootstrap]) {
            self.verifiedPeer = YES;
            completion(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:trust]);
        } else {
            self.error = CRError(@"电脑证书发生变化或无法验证。请核对电脑身份后重新配对。");
            completion(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
        }
    } else if ([method isEqual:NSURLAuthenticationMethodClientCertificate]) {
        // The client credential contains no application data. The server's pin
        // is independently checked before URLSession sends the HTTP request.
        completion(NSURLSessionAuthChallengeUseCredential, self.owner.credential);
    } else {
        completion(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
    }
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
 willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *))completion {
    self.error = CRError(@"电脑返回了重定向，已停止连接。");
    completion(nil);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task
 didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completion {
    if (![response isKindOfClass:NSHTTPURLResponse.class] ||
        ([task.originalRequest.URL.scheme isEqual:@"https"] && !self.verifiedPeer) ||
        response.expectedContentLength > (int64_t)self.limit) {
        self.error = CRError(@"电脑响应未通过验证或内容过大。");
        completion(NSURLSessionResponseCancel);
        return;
    }
    self.status = ((NSHTTPURLResponse *)response).statusCode;
    completion(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
    if (data.length > self.limit - self.bytes.length) {
        self.error = CRError(@"电脑返回的内容过大。");
        [task cancel];
        return;
    }
    [self.bytes appendData:data];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    if (!self.error) self.error = error;
    dispatch_semaphore_signal(self.finished);
}
@end

@implementation CRTransport
- (instancetype)initWithHost:(NSString *)host port:(NSUInteger)port certificate:(NSData *)certificate
                       pkcs12:(NSData *)pkcs12 error:(NSError **)error {
    self = [super init];
    if (!self) return nil;
    struct in6_addr address6;
    NSCharacterSet *dns = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"];
    BOOL validHost = host.length && host.length <= 253 &&
        (inet_pton(AF_INET6, host.UTF8String, &address6) == 1 || [host rangeOfCharacterFromSet:dns.invertedSet].location == NSNotFound);
    if (!validHost || port < 6 || port > 65514 || !pkcs12.length ||
        (certificate && (!certificate.length || certificate.length > 16384))) {
        if (error) *error = CRError(@"电脑地址、端口或本机配对身份无效。");
        return nil;
    }
    CFArrayRef items = NULL;
    OSStatus result = SecPKCS12Import((__bridge CFDataRef)pkcs12,
        (__bridge CFDictionaryRef)@{(__bridge id)kSecImportExportPassphrase:@"limelight"}, &items);
    if (result != errSecSuccess || !items || CFArrayGetCount(items) != 1) {
        if (items) CFRelease(items);
        if (error) *error = CRError(@"无法读取本机配对身份，请解锁设备后重试。");
        return nil;
    }
    NSDictionary *entry = (__bridge NSDictionary *)CFArrayGetValueAtIndex(items, 0);
    SecIdentityRef identity = (__bridge SecIdentityRef)entry[(__bridge id)kSecImportItemIdentity];
    SecCertificateRef leaf = NULL;
    if (!identity || SecIdentityCopyCertificate(identity, &leaf) != errSecSuccess) {
        CFRelease(items);
        if (error) *error = CRError(@"本机配对证书无效。");
        return nil;
    }
    _credential = [NSURLCredential credentialWithIdentity:identity certificates:@[(__bridge id)leaf] persistence:NSURLCredentialPersistenceNone];
    CFRelease(leaf);
    CFRelease(items);
    _host = [host copy]; _port = port; _identityData = pkcs12;
    _serverCertificate = [certificate copy]; _sessions = [NSMutableSet set];
    return self;
}
- (BOOL)acceptCertificate:(NSData *)certificate bootstrap:(BOOL)bootstrap {
    @synchronized (self) {
        if (_cancelled) return NO;
        if (!self.serverCertificate && bootstrap) self.serverCertificate = certificate;
        return [self.serverCertificate isEqual:certificate];
    }
}
- (NSURL *)URLForPath:(NSString *)path offset:(NSInteger)offset {
    NSURLComponents *url = [[NSURLComponents alloc] init];
    url.scheme = @"https"; url.host = self.host; url.port = @(self.port + offset); url.path = path;
    return url.URL;
}
- (CRHTTPResult *)perform:(NSURLRequest *)request bootstrap:(BOOL)bootstrap limit:(NSUInteger)limit error:(NSError **)error {
    NSURL *url = request.URL;
    BOOL secure = [url.scheme isEqual:@"https"];
    NSInteger port = url.port.integerValue;
    BOOL origin = [url.host caseInsensitiveCompare:self.host] == NSOrderedSame && !url.user && !url.password && !url.fragment;
    BOOL endpoint = secure ? (port == self.port - 5 || port == self.port + 2 || port == self.port + 3) :
        ([url.scheme isEqual:@"http"] && port == self.port && [request.HTTPMethod isEqual:@"GET"] && !request.HTTPBody &&
         ([url.path isEqual:@"/pair"] || ([url.path isEqual:@"/serverinfo"] && !self.serverCertificate)));
    BOOL bootstrapAllowed = bootstrap && secure && port == self.port + 3 &&
        [url.path isEqual:@"/v1/pair"] && [request.HTTPMethod isEqual:@"POST"];
    if (!request || !origin || !endpoint || (bootstrap && !bootstrapAllowed) ||
        (secure && !self.serverCertificate && !bootstrapAllowed) || !limit || limit > 12 * 1024 * 1024 ||
        request.HTTPBody.length > 12 * 1024 * 1024 || request.timeoutInterval <= 0 || request.timeoutInterval > 125) {
        if (error) *error = CRError(@"连接请求未通过校验，请重新添加电脑。");
        return nil;
    }
    CRHTTPExchange *exchange = [[CRHTTPExchange alloc] init];
    exchange.owner = self; exchange.bootstrap = bootstrapAllowed; exchange.limit = limit;
    exchange.bytes = [NSMutableData data]; exchange.finished = dispatch_semaphore_create(0);
    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    configuration.URLCache = nil; configuration.HTTPCookieStorage = nil; configuration.URLCredentialStorage = nil;
    configuration.connectionProxyDictionary = @{};
    configuration.timeoutIntervalForResource = request.timeoutInterval;
    configuration.TLSMinimumSupportedProtocolVersion = tls_protocol_version_TLSv12;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:exchange delegateQueue:nil];
    @synchronized (self) {
        if (_cancelled) {
            [session invalidateAndCancel];
            if (error) *error = CRError(@"操作已取消。");
            return nil;
        }
        [_sessions addObject:session];
        [[session dataTaskWithRequest:request] resume];
    }
    long timedOut = dispatch_semaphore_wait(exchange.finished, dispatch_time(DISPATCH_TIME_NOW, (int64_t)((request.timeoutInterval + 1) * NSEC_PER_SEC)));
    [session invalidateAndCancel];
    @synchronized (self) {
        [_sessions removeObject:session];
        if (_cancelled || timedOut) {
            if (error) *error = CRError(_cancelled ? @"操作已取消。" : @"电脑响应超时，请重试。");
            return nil;
        }
    }
    if (exchange.error) { if (error) *error = exchange.error; return nil; }
    CRHTTPResult *response = [[CRHTTPResult alloc] init];
    response.status = exchange.status; response.data = [exchange.bytes copy];
    return response;
}
- (NSDictionary *)JSON:(NSString *)path offset:(NSInteger)offset method:(NSString *)method body:(NSDictionary *)body
               headers:(NSDictionary *)headers bootstrap:(BOOL)bootstrap timeout:(NSTimeInterval)timeout
                 limit:(NSUInteger)limit error:(NSError **)error {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[self URLForPath:path offset:offset]
        cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:timeout];
    request.HTTPMethod = method;
    for (NSString *name in headers) [request setValue:headers[name] forHTTPHeaderField:name];
    if (body) {
        request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:error];
        if (!request.HTTPBody) return nil;
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    }
    CRHTTPResult *response = [self perform:request bootstrap:bootstrap limit:limit error:error];
    if (!response) return nil;
    if (response.status == 204 && [method isEqual:@"DELETE"]) return @{};
    if (response.status != 200) {
        NSString *message = response.status == 403 ? @"电脑已撤销此设备的访问权限，请重新配对。" :
            response.status == 404 ? @"电脑端版本不支持此功能，请先更新 ClipRelay。" :
            response.status == 409 ? @"电脑剪贴板为空、被锁定或内容已经改变，请重试。" : @"电脑暂时无法完成请求，请稍后重试。";
        if (error) *error = CRError(message);
        return nil;
    }
    id value = [NSJSONSerialization JSONObjectWithData:response.data options:0 error:error];
    if (![value isKindOfClass:NSDictionary.class]) {
        if (error) *error = CRError(@"电脑响应格式无效。");
        return nil;
    }
    return value;
}
- (CRTransport *)freshTransport {
    return [[CRTransport alloc] initWithHost:self.host port:self.port certificate:self.serverCertificate pkcs12:self.identityData error:nil];
}
- (void)cancel {
    @synchronized (self) {
        _cancelled = YES;
        for (NSURLSession *session in _sessions) [session invalidateAndCancel];
    }
}
@end
