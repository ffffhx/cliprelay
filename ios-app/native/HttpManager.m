// SPDX-License-Identifier: GPL-3.0-or-later
#import "HttpManager.h"
#import "CryptoManager.h"
#import "Utils.h"
#include <Limelight.h>

@implementation HttpManager {
    CRTransport *_transport;
    NSError *_setupError;
    NSString *_uniqueId;
    NSString *_pairingIdentifier;
}
- (CRTransport *)transport { return _transport; }
- (id)initWithHost:(TemporaryHost *)host {
    self = [self initWithAddress:host.activeAddress httpsPort:host.httpsPort serverCert:host.serverCert];
    return self;
}
- (id)initWithAddress:(NSString *)address httpsPort:(unsigned short)httpsPort serverCert:(NSData *)certificate {
    if (!(self = [super init])) return nil;
    NSString *host = [Utils addressPortStringToAddress:address];
    NSUInteger port = [Utils addressPortStringToPort:address];
    _transport = [[CRTransport alloc] initWithHost:host port:port certificate:certificate
        pkcs12:[CryptoManager readP12FromFile] error:&_setupError];
    NSData *identity = [CryptoManager pemToDer:[CryptoManager readCertFromFile]];
    if (identity.length) {
        NSData *hash = [[[CryptoManager alloc] init] SHA256HashData:identity];
        _uniqueId = [[[Utils bytesToHex:hash] substringToIndex:32] lowercaseString];
    }
    return self;
}
- (void)setServerCert:(NSData *)certificate {
    // Replacing a pin in-place is forbidden. Re-pairing requires a new manager.
    if (![_transport.serverCertificate isEqual:certificate]) [self cancel];
}
- (void)setPairingIdentifier:(NSString *)identifier {
    _pairingIdentifier = [identifier copy];
}
- (void)cancel { [_transport cancel]; }
- (NSURLRequest *)request:(NSString *)path secure:(BOOL)secure query:(NSDictionary *)query timeout:(NSTimeInterval)timeout {
    if (!_transport || !_uniqueId.length) return nil;
    NSURLComponents *url = [NSURLComponents componentsWithURL:[_transport URLForPath:path offset:secure ? -5 : 0] resolvingAgainstBaseURL:NO];
    if (!secure) url.scheme = @"http";
    NSMutableArray *items = [NSMutableArray array];
    for (NSString *key in query) [items addObject:[NSURLQueryItem queryItemWithName:key value:[query[key] description]]];
    if (items.count) url.queryItems = items;
    if (!url.URL) return nil;
    return [NSURLRequest requestWithURL:url.URL cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:timeout];
}
- (NSURLRequest *)pair:(NSDictionary *)fields secure:(BOOL)secure timeout:(NSTimeInterval)timeout {
    if (!_pairingIdentifier.length) return nil;
    NSMutableDictionary *query = [@{@"uniqueid":_pairingIdentifier, @"devicename":[@"ClipRelay-" stringByAppendingString:_pairingIdentifier],
        @"cliprelay_pairing":_pairingIdentifier, @"updateState":@"1", @"uuid":NSUUID.UUID.UUIDString} mutableCopy];
    [query addEntriesFromDictionary:fields];
    return [self request:@"/pair" secure:secure query:query timeout:timeout];
}
- (void)executeRequestSynchronously:(HttpRequest *)request {
    NSError *error = _setupError;
    CRHTTPResult *result = nil;
    if (request.request && !error) result = [_transport perform:request.request bootstrap:NO limit:8 * 1024 * 1024 error:&error];
    if (!result || result.status != 200) {
        request.response.statusCode = (int)(result ? result.status : -1);
        request.response.statusMessage = error.localizedDescription ?: (result.status == 403 ? @"电脑已撤销授权，请重新配对。" : @"无法连接电脑，请检查地址、权限和网络。");
        return;
    }
    // Paired requests never fall back to unencrypted discovery, including 401.
    NSData *data = result.data;
    if ([request.request.URL.path isEqual:@"/appasset"]) {
        [request.response populateWithData:data];
    } else {
        NSString *xml = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (!xml || [xml rangeOfString:@"<!DOCTYPE" options:NSCaseInsensitiveSearch].location != NSNotFound ||
            [xml rangeOfString:@"<!ENTITY" options:NSCaseInsensitiveSearch].location != NSNotFound) {
            request.response.statusCode = -1; request.response.statusMessage = @"电脑响应格式无效。"; return;
        }
        xml = [xml stringByReplacingOccurrencesOfString:@"UTF-16" withString:@"UTF-8" options:NSCaseInsensitiveSearch range:NSMakeRange(0, xml.length)];
        [request.response populateWithData:[xml dataUsingEncoding:NSUTF8StringEncoding]];
    }
}
- (NSURLRequest *)newPairRequest:(NSData *)salt clientCert:(NSData *)certificate {
    return [self pair:@{@"phrase":@"getservercert", @"salt":[Utils bytesToHex:salt], @"clientcert":[Utils bytesToHex:certificate]} secure:NO timeout:125];
}
- (NSURLRequest *)newUnpairRequest { return nil; }
- (NSURLRequest *)newChallengeRequest:(NSData *)challenge {
    return [self pair:@{@"clientchallenge":[Utils bytesToHex:challenge]} secure:NO timeout:10];
}
- (NSURLRequest *)newChallengeRespRequest:(NSData *)challenge {
    return [self pair:@{@"serverchallengeresp":[Utils bytesToHex:challenge]} secure:NO timeout:10];
}
- (NSURLRequest *)newClientSecretRespRequest:(NSString *)secret {
    return [self pair:@{@"clientpairingsecret":secret} secure:NO timeout:10];
}
- (NSURLRequest *)newPairChallenge {
    return [self pair:@{@"phrase":@"pairchallenge"} secure:YES timeout:10];
}
- (NSURLRequest *)newAppListRequest {
    return [self request:@"/applist" secure:YES query:@{@"uniqueid":_uniqueId ?: @""} timeout:10];
}
- (NSURLRequest *)newServerInfoRequest:(bool)fastFail {
    return [self request:@"/serverinfo" secure:_transport.serverCertificate != nil query:@{@"uniqueid":_uniqueId ?: @""} timeout:fastFail ? 2 : 5];
}
- (NSURLRequest *)newHttpServerInfoRequest:(bool)fastFail {
    if (_transport.serverCertificate) return [self newServerInfoRequest:fastFail];
    return [self request:@"/serverinfo" secure:NO query:@{} timeout:fastFail ? 2 : 5];
}
- (NSURLRequest *)newHttpServerInfoRequest { return [self newHttpServerInfoRequest:NO]; }
- (NSURLRequest *)newLaunchOrResumeRequest:(NSString *)verb config:(StreamConfiguration *)config {
    if (![@[@"launch", @"resume"] containsObject:verb] || !_transport.serverCertificate) return nil;
    NSMutableDictionary *query = [@{@"uniqueid":_uniqueId, @"appid":config.appID ?: @"",
        @"mode":[NSString stringWithFormat:@"%dx%dx%d", config.width, config.height, config.frameRate],
        @"additionalStates":@"1", @"sops":@"0", @"rikey":[Utils bytesToHex:config.riKey], @"rikeyid":@(config.riKeyId),
        @"localAudioPlayMode":@(config.playAudioOnPC ? 1 : 0),
        @"surroundAudioInfo":@(SURROUNDAUDIOINFO_FROM_AUDIO_CONFIGURATION(config.audioConfiguration)),
        @"remoteControllersBitmap":@(config.gamepadMask), @"gcmap":@(config.gamepadMask), @"gcpersist":@(config.multiController ? 0 : 1)} mutableCopy];
    if (config.supportedVideoFormats & VIDEO_FORMAT_MASK_10BIT) {
        [query addEntriesFromDictionary:@{@"hdrMode":@"1", @"clientHdrCapVersion":@"0", @"clientHdrCapSupportedFlagsInUint32":@"0",
            @"clientHdrCapMetaDataId":@"NV_STATIC_METADATA_TYPE_1", @"clientHdrCapDisplayData":@"0x0x0x0x0x0x0x0x0x0x0"}];
    }
    // Keep native encryption negotiation and RTSP parameters from the pinned core.
    NSString *native = [NSString stringWithUTF8String:LiGetLaunchUrlQueryParameters()];
    NSURLComponents *extension = [NSURLComponents componentsWithString:[@"https://localhost/?" stringByAppendingString:[native hasPrefix:@"&"] ? [native substringFromIndex:1] : native]];
    for (NSURLQueryItem *item in extension.queryItems) if (item.value) query[item.name] = item.value;
    return [self request:[@"/" stringByAppendingString:verb] secure:YES query:query timeout:60];
}
- (NSURLRequest *)newQuitAppRequest {
    return [self request:@"/cancel" secure:YES query:@{@"uniqueid":_uniqueId ?: @""} timeout:15];
}
- (NSURLRequest *)newAppAssetRequestWithAppId:(NSString *)appID {
    return [self request:@"/appasset" secure:YES query:@{@"uniqueid":_uniqueId ?: @"", @"appid":appID, @"AssetType":@"2", @"AssetIdx":@"0"} timeout:10];
}
@end
