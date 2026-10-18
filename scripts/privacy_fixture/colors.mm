// Disposable CI color window and unsaved 16x16 local-display sample. No input
// injection, arbitrary window selection or full-desktop images are exposed.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>

static NSWindow *backdrop;
static SCContentFilter *filter;
static SCStreamConfiguration *configuration;

static void emit(NSDictionary *value) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nullptr];
  if (!json || fwrite(json.bytes,1,json.length,stdout)!=json.length || fputc('\n',stdout)==EOF || fflush(stdout)) _exit(3);
}
static NSString *pixel(unsigned r,unsigned g,unsigned b) {
  if (r>180 && g<80 && b<80) return @"red";
  if (g>180 && r<80 && b<80) return @"green";
  if (b>180 && r<80 && g<80) return @"blue";
  if (r<35 && g<35 && b<35) return @"black";
  return @"mixed";
}
static void sample(void) {
  [SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef image,NSError *error) {
    if (error || !image || CGImageGetWidth(image)!=16 || CGImageGetHeight(image)!=16) {
      emit(@{@"event":@"error",@"code":@"LOCAL_SAMPLE",@"nativeCode":@(error.code),
        @"width":@(image?CGImageGetWidth(image):0),@"height":@(image?CGImageGetHeight(image):0)});_exit(4);
    }
    unsigned char rgba[16*16*4] = {0};
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(rgba,16,16,8,16*4,color,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(color);
    if (!context) _exit(4);
    CGContextDrawImage(context,CGRectMake(0,0,16,16),image);
    CGContextRelease(context);
    NSString *result = nil;
    for (unsigned y=4;y<=12;y+=4) for (unsigned x=4;x<=12;x+=4) {
      const unsigned char *p=rgba+(y*16+x)*4;
      NSString *value=pixel(p[0],p[1],p[2]);
      if (!result) result=value;
      else if (![result isEqualToString:value]) result=@"mixed";
    }
    memset(rgba,0,sizeof rgba);
    emit(@{@"event":@"sample",@"color":result});
  }];
}
int main(void) {
  @autoreleasepool {
    struct stat channel;
    if (!getenv("GITHUB_ACTIONS") || strcmp(getenv("GITHUB_ACTIONS"),"true") || getppid()<=1 ||
        fstat(STDIN_FILENO,&channel) || !(S_ISFIFO(channel.st_mode)||S_ISSOCK(channel.st_mode))) return 2;
    const pid_t owner=getppid();
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
      for (int i=0;i<1200;++i) { if (getppid()!=owner) _exit(3); usleep(100000); }
      _exit(3);
    });
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    if (NSScreen.screens.count!=1) return 2;
    NSScreen *screen=NSScreen.screens.firstObject;
    const CGDirectDisplayID identifier=[screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
    backdrop=[[NSWindow alloc] initWithContentRect:screen.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    backdrop.releasedWhenClosed=NO;backdrop.backgroundColor=NSColor.redColor;backdrop.opaque=YES;
    backdrop.hasShadow=NO;backdrop.ignoresMouseEvents=YES;backdrop.level=NSFloatingWindowLevel;
    backdrop.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary;
    [backdrop orderFrontRegardless];
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content,NSError *error) {
      if (error || !content) { emit(@{@"event":@"error",@"code":@"LOCAL_CONTENT",@"nativeCode":@(error.code)});_exit(4); }
      dispatch_async(dispatch_get_main_queue(),^{
        SCDisplay *display=nil;
        for (SCDisplay *candidate in content.displays) if (candidate.displayID==identifier) display=candidate;
        if (!display) _exit(4);
        filter=[[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        configuration=[SCStreamConfiguration new];configuration.width=16;configuration.height=16;
        configuration.showsCursor=NO;configuration.pixelFormat=kCVPixelFormatType_32BGRA;
        configuration.sourceRect=CGRectMake(display.frame.size.width/2-8,display.frame.size.height/2-8,16,16);
        emit(@{@"event":@"ready",@"display":@(identifier),@"window":@(backdrop.windowNumber)});
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
          char buffer[16];size_t length=0;
          for (;;) {
            struct pollfd input={STDIN_FILENO,POLLIN,0};
            if (poll(&input,1,100)<0) { if (errno==EINTR) continue; _exit(3); }
            if (!(input.revents&POLLIN)) { if (input.revents) _exit(0); continue; }
            char next;if (read(STDIN_FILENO,&next,1)!=1) _exit(0);
            if (next!='\n') { if (length==sizeof(buffer)-1 || next<'a' || next>'z') _exit(2);buffer[length++]=next;continue; }
            buffer[length]=0;NSString *command=[NSString stringWithUTF8String:buffer];length=0;
            if (![@[@"red",@"green",@"blue",@"sample"] containsObject:command]) _exit(2);
            dispatch_async(dispatch_get_main_queue(),^{
              if ([command isEqualToString:@"sample"]) { sample();return; }
              backdrop.backgroundColor=[command isEqualToString:@"red"]?NSColor.redColor:[command isEqualToString:@"green"]?NSColor.greenColor:NSColor.blueColor;
              [backdrop display];emit(@{@"event":@"paint",@"color":command});
            });
          }
        });
      });
    }];
    [NSApp run];
    return 0;
  }
}
