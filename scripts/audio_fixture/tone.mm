// Owned, quiet synthetic source on disposable CI. Never ship or run on a user Mac.
// https://developer.apple.com/documentation/audiotoolbox/audioqueueoutputcallback
#import <Foundation/Foundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <atomic>
#include <cmath>
#include <thread>
#include <chrono>
#include <sys/stat.h>
#include <unistd.h>
static std::atomic<unsigned> frequency{0}, callbacks{0};
static std::atomic<int> callback_error{0};
static std::atomic<bool> stopping{false}, finished{false};
static uint64_t sample_index;
static void fill(void *context,AudioQueueRef queue,AudioQueueBufferRef buffer) {
  (void)context;if (stopping.load()) return;
  float *values=(float *)buffer->mAudioData;
  const unsigned hz=frequency.load();
  for (unsigned i=0;i<480;++i) {
    const float value=hz ? .04*std::sin(6.2831853071795864769*hz*(sample_index%48000)/48000) : 0;
    ++sample_index;values[2*i]=value;values[2*i+1]=value;
  }
  buffer->mAudioDataByteSize=480*2*sizeof(float);
  OSStatus status=AudioQueueEnqueueBuffer(queue,buffer,0,nullptr);
  if (status!=noErr) callback_error.store(status);
  ++callbacks;
}
static void check(OSStatus status) {
  if (status!=noErr) { printf("{\"event\":\"error\",\"status\":%d}\n",(int)status);fflush(stdout);_exit(3); }
}
static void property(AudioObjectID object,AudioObjectPropertySelector selector,void *value,UInt32 expected) {
  AudioObjectPropertyAddress address={selector,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
  UInt32 size=expected;check(AudioObjectGetPropertyData(object,&address,0,nullptr,&size,value));
  if (size!=expected) _exit(3);
}
static void report(const char *event) {
  AudioDeviceID output=0,input=0;Float64 rate=0;UInt32 frames=0;
  property(kAudioObjectSystemObject,kAudioHardwarePropertyDefaultOutputDevice,&output,sizeof output);
  property(kAudioObjectSystemObject,kAudioHardwarePropertyDefaultInputDevice,&input,sizeof input);
  property(output,kAudioDevicePropertyNominalSampleRate,&rate,sizeof rate);
  property(output,kAudioDevicePropertyBufferFrameSize,&frames,sizeof frames);
  printf("{\"event\":\"%s\",\"frequency\":%u,\"callbacks\":%u,\"errors\":%d,"
         "\"route\":{\"output\":%u,\"input\":%u,\"rate\":%.0f,\"frames\":%u}}\n",
         event,frequency.load(),callbacks.load(),callback_error.load(),output,input,rate,frames);
  fflush(stdout);
}
static void consent_windows(void) {
  // Read only, no AX actions and no permission request. Inspect only system
  // consent brokers on this disposable runner, never ordinary applications.
  NSMutableArray *observations=[NSMutableArray array];
  const BOOL trusted=AXIsProcessTrusted();
  const auto end=std::chrono::steady_clock::now()+std::chrono::seconds(3);
  NSSet *brokers=[NSSet setWithArray:@[@"com.apple.UserNotificationCenter",@"com.apple.notificationcenterui",
    @"com.apple.SecurityAgent",@"com.apple.CoreServicesUIAgent",@"com.apple.controlcenter"]];
  if (trusted) for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
    if (![brokers containsObject:app.bundleIdentifier]) continue;
    AXUIElementRef element=AXUIElementCreateApplication(app.processIdentifier);
    AXUIElementSetMessagingTimeout(element,.1);
    NSMutableArray *queue=[NSMutableArray arrayWithObject:(__bridge id)element],*texts=[NSMutableArray array];
    CFRelease(element);NSUInteger count=0;AXError last=kAXErrorSuccess;
    while (queue.count && count++<100 && texts.count<16 && std::chrono::steady_clock::now()<end) {
      id node=queue.firstObject;[queue removeObjectAtIndex:0];
      for (NSString *attribute in @[@"AXTitle",@"AXDescription",@"AXValue"]) {
        CFTypeRef value=nullptr;last=AXUIElementCopyAttributeValue((__bridge AXUIElementRef)node,(__bridge CFStringRef)attribute,&value);
        if (value) {
          if (CFGetTypeID(value)==CFStringGetTypeID()) {
            NSString *text=(__bridge NSString *)value;
            if (text.length && ![texts containsObject:text]) [texts addObject:[text substringToIndex:MIN(text.length,(NSUInteger)240)]];
          }
          CFRelease(value);
        }
      }
      CFTypeRef children=nullptr;
      if (AXUIElementCopyAttributeValue((__bridge AXUIElementRef)node,kAXChildrenAttribute,&children)==kAXErrorSuccess && children) {
        if (CFGetTypeID(children)==CFArrayGetTypeID()) for (id child in (__bridge NSArray *)children) {
          if (queue.count<100 && CFGetTypeID((__bridge CFTypeRef)child)==AXUIElementGetTypeID()) [queue addObject:child];
        }
        CFRelease(children);
      }
    }
    [observations addObject:@{@"bundle":app.bundleIdentifier,@"texts":texts,@"lastAXError":@(last)}];
  }
  NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"event":@"consent-windows",@"trusted":@(trusted),@"brokers":observations}
    options:0 error:nullptr];
  if (!json || json.length>12000) _exit(3);
  fwrite(json.bytes,1,json.length,stdout);fputc('\n',stdout);fflush(stdout);
}
int main(void) {
  @autoreleasepool {
    struct stat channel;
    if (!getenv("GITHUB_ACTIONS") || strcmp(getenv("GITHUB_ACTIONS"),"true") || getppid()<=1 ||
        fstat(STDIN_FILENO,&channel)!=0 || !(S_ISFIFO(channel.st_mode)||S_ISSOCK(channel.st_mode))) return 2;
    const pid_t owner=getppid();
    std::thread guard([owner]{
      const auto end=std::chrono::steady_clock::now()+std::chrono::seconds(180);
      while (!finished.load()) {
        if (getppid()!=owner || std::chrono::steady_clock::now()>=end) _exit(4);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
    });
    AudioStreamBasicDescription format={};
    format.mSampleRate=48000;format.mFormatID=kAudioFormatLinearPCM;
    format.mFormatFlags=kAudioFormatFlagIsFloat|kAudioFormatFlagIsPacked;
    format.mBytesPerPacket=8;format.mFramesPerPacket=1;format.mBytesPerFrame=8;
    format.mChannelsPerFrame=2;format.mBitsPerChannel=32;
    AudioQueueRef queue=nullptr;
    check(AudioQueueNewOutput(&format,fill,nullptr,nullptr,nullptr,0,&queue));
    for (unsigned i=0;i<3;++i) {
      AudioQueueBufferRef buffer=nullptr;check(AudioQueueAllocateBuffer(queue,480*8,&buffer));fill(nullptr,queue,buffer);
    }
    check(AudioQueueStart(queue,nullptr));report("ready");
    char command[32];bool valid=true;
    while (fgets(command,sizeof command,stdin)) {
      if (!strcmp(command,"consent-windows\n")) { consent_windows();continue; }
      else if (!strcmp(command,"quiet\n")) frequency.store(0);
      else if (!strcmp(command,"low\n")) frequency.store(1000);
      else if (!strcmp(command,"high\n")) frequency.store(1600);
      else if (strcmp(command,"state\n")) { valid=false;break; }
      report("state");
    }
    stopping.store(true);check(AudioQueueStop(queue,true));check(AudioQueueDispose(queue,true));
    finished.store(true);guard.join();return valid && callback_error.load()==0 ? 0 : 3;
  }
}
