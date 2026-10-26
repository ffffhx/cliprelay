// SPDX-License-Identifier: GPL-3.0-or-later
// ClipRelay's certificate-bound bootstrap followed by the native Sunshine proof.
#import "PairManager.h"
#import "CryptoManager.h"
#import "Utils.h"
#import "CRPairingTicket.h"

@implementation PairManager {
    HttpManager *_httpManager;
    NSData *_clientCert;
    __weak id<PairCallback> _callback;
    CRPairingTicket *_ticket;
    CRTransport *_feedbackTransport;
    NSError *_failure;
    BOOL _completed;
    NSTimeInterval _deadline;
}
- (id)initWithManager:(HttpManager *)manager clientCert:(NSData *)certificate callback:(id<PairCallback>)callback {
    if ((self = [super init])) { _httpManager = manager; _clientCert = certificate; _callback = callback; }
    return self;
}
- (void)notify:(void (^)(id<PairCallback>))action {
    dispatch_async(dispatch_get_main_queue(), ^{
        id<PairCallback> callback = self->_callback;
        if (!self.cancelled && callback && [callback isCurrentPairing:self]) action(callback);
    });
}
- (void)cancel {
    [super cancel];
    [_httpManager cancel];
    @synchronized (self) { [_feedbackTransport cancel]; }
}
- (BOOL)check:(NSError **)error {
    @synchronized (self) {
        if (_failure) { if (error) *error = _failure; return NO; }
        if (self.cancelled) { if (error) *error = CRError(@"配对已取消。"); return NO; }
        if (_deadline && NSProcessInfo.processInfo.systemUptime >= _deadline) {
            if (error) *error = CRError(@"配对已超时，请重新发起。"); return NO;
        }
        return YES;
    }
}
- (HttpResponse *)exchange:(NSURLRequest *)request error:(NSError **)error {
    if (![self check:error]) return nil;
    HttpResponse *response = [[HttpResponse alloc] init];
    [_httpManager executeRequestSynchronously:[HttpRequest requestForResponse:response withUrlRequest:request]];
    if (![self check:error]) return nil;
    if (![response isStatusOk] || ![[response getStringTag:@"paired"] isEqual:@"1"]) {
        // A native refusal can beat the feedback poll. Preserve a bound terminal reason.
        NSError *observed = nil;
        NSDictionary *status = [_feedbackTransport JSON:@"/v1/pair/status" offset:3 method:@"POST"
            body:@{@"id":_ticket.identifier, @"receipt":_ticket.receipt} headers:@{} bootstrap:NO timeout:2 limit:2048 error:nil];
        if (status) [_ticket observe:status error:&observed];
        if (error) *error = observed ?: CRError(@"电脑未完成配对，请确认电脑端已允许连接后重试。");
        return nil;
    }
    return response;
}
- (void)monitor {
    NSUInteger failures = 0;
    for (;;) {
        @synchronized (self) { if (_completed || self.cancelled) return; }
        NSError *error = nil;
        if (![self check:&error]) { /* expired or cancelled */ }
        else {
            NSDictionary *value = [_feedbackTransport JSON:@"/v1/pair/status" offset:3 method:@"POST"
                body:@{@"id":_ticket.identifier, @"receipt":_ticket.receipt} headers:@{} bootstrap:NO timeout:4 limit:2048 error:&error];
            if (value) { failures = 0; [_ticket observe:value error:&error]; }
            else if (++failures < 3) error = nil;
        }
        if (error) {
            @synchronized (self) {
                if (_completed || self.cancelled) return;
                _failure = error;
            }
            [_httpManager cancel]; return;
        }
        [NSThread sleepForTimeInterval:0.5];
    }
}
- (BOOL)prove:(NSString *)pin error:(NSError **)error {
    CryptoManager *crypto = [[CryptoManager alloc] init];
    NSData *salt = [Utils randomBytes:16];
    NSMutableData *salted = [salt mutableCopy]; [salted appendData:[pin dataUsingEncoding:NSUTF8StringEncoding]];
    NSData *key = [crypto createAESKeyFromSaltSHA256:salted];
    HttpResponse *certificate = [self exchange:[_httpManager newPairRequest:salt clientCert:_clientCert] error:error];
    if (!certificate) return NO;
    NSData *hostPEM = [Utils hexToBytes:[certificate getStringTag:@"plaincert"]];
    NSData *hostDER = [CryptoManager pemToDer:hostPEM];
    if (!hostDER || ![hostDER isEqual:_httpManager.transport.serverCertificate]) {
        if (error) *error = CRError(@"配对过程中电脑证书发生变化，已停止连接。"); return NO;
    }
    NSData *challenge = [Utils randomBytes:16];
    HttpResponse *challengeReply = [self exchange:[_httpManager newChallengeRequest:[crypto aesEncrypt:challenge withKey:key]] error:error];
    if (!challengeReply) return NO;
    NSData *encrypted = [Utils hexToBytes:[challengeReply getStringTag:@"challengeresponse"]];
    if (encrypted.length != 48) { if (error) *error = CRError(@"电脑返回的配对挑战无效。"); return NO; }
    NSData *decoded = [crypto aesDecrypt:encrypted withKey:key];
    NSData *secret = [Utils randomBytes:16];
    NSMutableData *proofInput = [[decoded subdataWithRange:NSMakeRange(32, 16)] mutableCopy];
    NSData *clientSignature = [CryptoManager getSignatureFromCert:_clientCert];
    if (!clientSignature.length) { if (error) *error = CRError(@"本机配对证书无效。"); return NO; }
    [proofInput appendData:clientSignature]; [proofInput appendData:secret];
    HttpResponse *secretReply = [self exchange:[_httpManager newChallengeRespRequest:[crypto aesEncrypt:[crypto SHA256HashData:proofInput] withKey:key]] error:error];
    if (!secretReply) return NO;
    NSData *hostProof = [Utils hexToBytes:[secretReply getStringTag:@"pairingsecret"]];
    if (hostProof.length < 64 || hostProof.length > 8192) { if (error) *error = CRError(@"电脑返回的签名无效。"); return NO; }
    NSData *hostSecret = [hostProof subdataWithRange:NSMakeRange(0, 16)];
    NSData *hostSignature = [hostProof subdataWithRange:NSMakeRange(16, hostProof.length - 16)];
    if (![crypto verifySignature:hostSecret withSignature:hostSignature andCert:hostPEM]) {
        if (error) *error = CRError(@"电脑签名验证失败。"); return NO;
    }
    NSMutableData *expected = [challenge mutableCopy];
    NSData *certificateSignature = [CryptoManager getSignatureFromCert:hostPEM];
    if (!certificateSignature) { if (error) *error = CRError(@"电脑证书无效。"); return NO; }
    [expected appendData:certificateSignature]; [expected appendData:hostSecret];
    if (![[crypto SHA256HashData:expected] isEqual:[decoded subdataWithRange:NSMakeRange(0, 32)]]) {
        if (error) *error = CRError(@"配对验证失败，请重新核对两端标识。"); return NO;
    }
    NSData *signature = [crypto signData:secret withKey:[CryptoManager readKeyFromFile]];
    if (!signature.length) { if (error) *error = CRError(@"无法使用本机配对身份签名。"); return NO; }
    NSMutableData *clientProof = [secret mutableCopy]; [clientProof appendData:signature];
    if (![self exchange:[_httpManager newClientSecretRespRequest:[Utils bytesToHex:clientProof]] error:error]) return NO;
    return [self exchange:[_httpManager newPairChallenge] error:error] != nil;
}
- (void)main {
    if (self.cancelled) return;
    [self notify:^(id<PairCallback> callback) { [callback startPairing:@"正在联系电脑…"]; }];
    NSError *error = nil;
    NSString *pin = [NSString stringWithFormat:@"%04u", arc4random_uniform(10000)];
    NSString *nonce = [[Utils bytesToHex:[Utils randomBytes:16]] lowercaseString];
    dispatch_group_t group = dispatch_group_create();
    BOOL success = NO;
    @try {
        NSDictionary *reply = [_httpManager.transport JSON:@"/v1/pair" offset:3 method:@"POST"
            body:@{@"name":@"ClipRelay iOS", @"nonce":nonce, @"pin":pin}
            headers:@{@"X-ClipRelay-Pairing-Feedback":@"1", @"X-ClipRelay-Pairing-Native":@"1"}
            bootstrap:YES timeout:6 limit:2048 error:&error];
        if (reply && [self check:&error]) {
            _ticket = [CRPairingTicket ticket:reply server:_httpManager.transport.serverCertificate
                client:[CryptoManager pemToDer:_clientCert] nonce:nonce now:NSDate.date.timeIntervalSince1970 error:&error];
        }
        if (_ticket && [self check:&error]) {
            _deadline = NSProcessInfo.processInfo.systemUptime + MIN(120, _ticket.expires - NSDate.date.timeIntervalSince1970);
            [_httpManager setPairingIdentifier:_ticket.nativeIdentifier];
            @synchronized (self) { _feedbackTransport = [_httpManager.transport freshTransport]; }
            [self notify:^(id<PairCallback> callback) { [callback updatePairingCode:self->_ticket.verification]; }];
            dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ [self monitor]; });
            success = [self prove:pin error:&error];
        }
    } @catch (NSException *exception) {
        error = CRError(@"配对数据无效，已停止连接。");
    } @finally {
        @synchronized (self) {
            if (_failure) { error = _failure; success = NO; }
            if (self.cancelled || (_deadline && NSProcessInfo.processInfo.systemUptime >= _deadline)) success = NO;
            _completed = YES; [_feedbackTransport cancel];
        }
        dispatch_group_wait(group, DISPATCH_TIME_FOREVER);
        // Request-scoped cleanup never calls Moonlight's global /unpair endpoint.
        if (_ticket) {
            CRTransport *cleanup = [_httpManager.transport freshTransport];
            [cleanup JSON:[@"/v1/pair/" stringByAppendingString:_ticket.identifier] offset:3 method:@"DELETE" body:nil
                headers:@{@"X-ClipRelay-Pairing-Receipt":_ticket.receipt} bootstrap:NO timeout:2 limit:2048 error:nil];
            [cleanup cancel];
        }
        [_httpManager cancel];
    }
    if (success) {
        NSData *certificate = _httpManager.transport.serverCertificate;
        [self notify:^(id<PairCallback> callback) { [callback pairSuccessful:certificate]; }];
    } else {
        NSString *message = error.localizedDescription ?: @"配对已结束，请重新发起。";
        [self notify:^(id<PairCallback> callback) { [callback pairFailed:message]; }];
    }
}
@end
