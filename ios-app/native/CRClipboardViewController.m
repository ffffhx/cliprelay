// SPDX-License-Identifier: GPL-3.0-or-later
#import "CRClipboardViewController.h"
#import "HttpManager.h"
#import "Utils.h"
#import <ImageIO/ImageIO.h>

static BOOL CRValidPNG(NSData *data) {
    static const unsigned char signature[] = {137,80,78,71,13,10,26,10};
    if (data.length < 24 || data.length > 8 * 1024 * 1024 || memcmp(data.bytes, signature, sizeof(signature))) return NO;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return NO;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    CFRelease(source);
    uint64_t width = [properties[(__bridge id)kCGImagePropertyPixelWidth] unsignedLongLongValue];
    uint64_t height = [properties[(__bridge id)kCGImagePropertyPixelHeight] unsignedLongLongValue];
    return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 6000000;
}
static BOOL CRValidText(NSString *text) {
    unichar zero = 0;
    return [text isKindOfClass:NSString.class] && text.length && [text dataUsingEncoding:NSUTF8StringEncoding].length <= 1024 * 1024 &&
        [text rangeOfString:[NSString stringWithCharacters:&zero length:1]].location == NSNotFound;
}

@implementation CRClipboardViewController {
    NSString *_address;
    NSData *_certificate;
    UITextView *_text;
    UILabel *_status;
    NSData *_image;
    HttpManager *_manager;
    NSObject *_operation;
    NSArray<UIButton *> *_buttons;
}
- (instancetype)initWithHost:(TemporaryHost *)host {
    if ((self = [super init])) {
        _address = [host.activeAddress copy]; _certificate = [host.serverCert copy];
        self.title = [NSString stringWithFormat:@"%@ · 剪贴板", host.name ?: @"电脑"];
    }
    return self;
}
- (UIButton *)button:(NSString *)title action:(SEL)action {
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    [button setTitle:title forState:UIControlStateNormal];
    [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
    [button.heightAnchor constraintGreaterThanOrEqualToConstant:44].active = YES;
    return button;
}
- (void)viewDidLoad {
    [super viewDidLoad]; self.view.backgroundColor = UIColor.systemBackgroundColor;
    self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithTitle:@"完成" style:UIBarButtonItemStyleDone target:self action:@selector(close)];
    _text = [[UITextView alloc] init]; _text.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
    _text.backgroundColor = UIColor.secondarySystemBackgroundColor; _text.layer.cornerRadius = 8;
    _text.accessibilityLabel = @"要发送的文字或收到的电脑剪贴板";
    _status = [[UILabel alloc] init]; _status.numberOfLines = 0; _status.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
    _status.text = @"输入文字，或点“粘贴本机内容”。只有点击按钮才会读取、发送或复制剪贴板。";
    UIButton *paste = [self button:@"粘贴本机内容" action:@selector(paste)];
    UIButton *send = [self button:@"发送到电脑" action:@selector(send)];
    UIButton *receive = [self button:@"读取电脑剪贴板" action:@selector(receive)];
    UIButton *copy = [self button:@"复制到本机" action:@selector(copyContent)];
    _buttons = @[paste, send, receive, copy];
    UIStackView *first = [[UIStackView alloc] initWithArrangedSubviews:@[paste, send]];
    UIStackView *second = [[UIStackView alloc] initWithArrangedSubviews:@[receive, copy]];
    first.distribution = second.distribution = UIStackViewDistributionFillEqually;
    UIStackView *layout = [[UIStackView alloc] initWithArrangedSubviews:@[_text, first, second, _status]];
    layout.axis = UILayoutConstraintAxisVertical; layout.spacing = 8; layout.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:layout];
    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[[layout.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:16],
        [layout.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-16],
        [layout.topAnchor constraintEqualToAnchor:safe.topAnchor constant:8], [layout.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-8]]];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(cancelOperation) name:UIApplicationDidEnterBackgroundNotification object:nil];
}
- (void)cancelOperation {
    if (_operation) _status.text = @"操作已停止。发送请求可能已经到达电脑，请先检查电脑剪贴板。";
    _operation = nil; [_manager cancel]; _manager = nil;
    for (UIButton *button in _buttons) button.enabled = YES;
}
- (void)close { [self cancelOperation]; [self dismissViewControllerAnimated:YES completion:nil]; }
- (void)viewDidDisappear:(BOOL)animated { [super viewDidDisappear:animated]; [self cancelOperation]; }
- (void)dealloc { [_manager cancel]; [[NSNotificationCenter defaultCenter] removeObserver:self]; }
- (void)paste {
    UIPasteboard *pasteboard = UIPasteboard.generalPasteboard;
    if (pasteboard.hasImages) {
        UIImage *image = pasteboard.image;
        size_t width = image.CGImage ? CGImageGetWidth(image.CGImage) : 0, height = image.CGImage ? CGImageGetHeight(image.CGImage) : 0;
        if (!width || !height || width > 4096 || height > 4096 || width * height > 6000000) { _status.text = @"图片过大，最多支持 4096 像素边长和 600 万像素。"; return; }
        NSData *png = UIImagePNGRepresentation(image);
        if (!CRValidPNG(png)) { _status.text = @"图片无效或超过 8 MB。"; return; }
        _image = png; _text.text = @""; _text.editable = NO; _status.text = @"已准备本机图片，点击“发送到电脑”。";
    } else {
        NSString *text = pasteboard.string;
        if (!CRValidText(text)) { _status.text = @"剪贴板没有可发送的文字或图片，或文字超过 1 MB。"; return; }
        _image = nil; _text.editable = YES; _text.text = text; _status.text = @"已粘贴本机文字，可编辑后发送。";
    }
}
- (void)run:(NSDictionary *(^)(CRTransport *, NSError **))work completion:(void (^)(NSDictionary *))completion {
    if (_operation || !_certificate.length) return;
    [_text resignFirstResponder];
    NSObject *operation = [[NSObject alloc] init]; _operation = operation;
    _manager = [[HttpManager alloc] initWithAddress:_address httpsPort:0 serverCert:_certificate];
    CRTransport *transport = _manager.transport;
    for (UIButton *button in _buttons) button.enabled = NO;
    _status.text = @"正在与电脑安全通信…";
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSError *error = nil;
        NSDictionary *result = transport ? work(transport, &error) : nil;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self->_operation != operation) return;
            self->_operation = nil; [self->_manager cancel]; self->_manager = nil;
            for (UIButton *button in self->_buttons) button.enabled = YES;
            if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
            if (!result) self->_status.text = error.localizedDescription ?: @"无法完成操作，请重试。";
            else completion(result);
        });
    });
}
- (void)send {
    NSMutableDictionary *body = [@{@"op":@"write", @"id":[[Utils bytesToHex:[Utils randomBytes:16]] lowercaseString]} mutableCopy];
    if (_image) { body[@"kind"] = @"png"; body[@"data"] = [_image base64EncodedStringWithOptions:0]; }
    else {
        if (!CRValidText(_text.text)) { _status.text = @"请输入不超过 1 MB 的文字。"; return; }
        body[@"kind"] = @"text"; body[@"text"] = _text.text;
    }
    [self run:^NSDictionary *(CRTransport *transport, NSError **error) {
        NSDictionary *value = [transport JSON:@"/v1/clipboard" offset:2 method:@"POST" body:body headers:@{} bootstrap:NO timeout:20 limit:2048 error:error];
        if (![value[@"ok"] isEqual:@YES] || value.count != 1) { if (error && !*error) *error = CRError(@"电脑未确认写入，请先检查电脑剪贴板。"); return nil; }
        return value;
    } completion:^(NSDictionary *value) { self->_status.text = @"已发送，电脑端可以粘贴。"; }];
}
- (void)receive {
    [self run:^NSDictionary *(CRTransport *transport, NSError **error) {
        NSDictionary *value = [transport JSON:@"/v1/clipboard" offset:2 method:@"POST" body:@{@"op":@"read"} headers:@{} bootstrap:NO timeout:20 limit:12 * 1024 * 1024 error:error];
        BOOL valid = [value[@"ok"] isEqual:@YES];
        if ([value[@"kind"] isEqual:@"text"]) valid = valid && value.count == 3 && CRValidText(value[@"text"]);
        else if ([value[@"kind"] isEqual:@"png"] && [value[@"data"] isKindOfClass:NSString.class]) {
            NSData *png = [[NSData alloc] initWithBase64EncodedString:value[@"data"] options:0];
            valid = valid && value.count == 3 && CRValidPNG(png) && [[png base64EncodedStringWithOptions:0] isEqual:value[@"data"]];
        } else valid = NO;
        if (!valid) { if (error && !*error) *error = CRError(@"电脑返回的剪贴板内容无效。"); return nil; }
        return value;
    } completion:^(NSDictionary *value) {
        if ([value[@"kind"] isEqual:@"png"]) {
            self->_image = [[NSData alloc] initWithBase64EncodedString:value[@"data"] options:0];
            self->_text.text = @""; self->_text.editable = NO; self->_status.text = @"已收到电脑图片，点击“复制到本机”后可粘贴。";
        } else {
            self->_image = nil; self->_text.editable = YES; self->_text.text = value[@"text"];
            self->_status.text = @"已收到电脑文字，点击“复制到本机”后可粘贴。";
        }
    }];
}
- (void)copyContent {
    if (_image) [UIPasteboard.generalPasteboard setData:_image forPasteboardType:@"public.png"];
    else if (CRValidText(_text.text)) UIPasteboard.generalPasteboard.string = _text.text;
    else { _status.text = @"当前没有可复制的内容。"; return; }
    _status.text = @"已复制到本机。";
}
@end
