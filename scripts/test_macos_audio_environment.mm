// Read-only disposable CI prerequisite probe. No tap, aggregate device,
// permission request, capture, playback or device-setting writes.
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#include <dlfcn.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

static NSMutableArray *errors;
static bool read_property(AudioObjectID object,AudioObjectPropertySelector selector,
                          AudioObjectPropertyScope scope,void *value,UInt32 expected) {
  AudioObjectPropertyAddress address={selector,scope,kAudioObjectPropertyElementMain};
  UInt32 bytes=expected;
  OSStatus status=AudioObjectGetPropertyData(object,&address,0,nullptr,&bytes,value);
  if (status!=noErr || bytes!=expected) { [errors addObject:@{@"selector":@(selector),@"status":@(status),@"bytes":@(bytes)}];return false; }
  return true;
}
static unsigned channels(AudioDeviceID device,AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress address={kAudioDevicePropertyStreamConfiguration,scope,kAudioObjectPropertyElementMain};
  UInt32 bytes=0;OSStatus status=AudioObjectGetPropertyDataSize(device,&address,0,nullptr,&bytes);
  if (status!=noErr || bytes<offsetof(AudioBufferList,mBuffers) || bytes>65536) {
    [errors addObject:@{@"operation":@"stream-size",@"status":@(status)}];return 0;
  }
  void *storage=calloc(1,bytes);if (!storage) exit(3);
  const UInt32 capacity=bytes;
  status=AudioObjectGetPropertyData(device,&address,0,nullptr,&bytes,storage);
  AudioBufferList *list=(AudioBufferList *)storage;
  unsigned result=0;
  if (status!=noErr || bytes>capacity || bytes<offsetof(AudioBufferList,mBuffers) ||
      list->mNumberBuffers>32 || offsetof(AudioBufferList,mBuffers)+list->mNumberBuffers*sizeof(AudioBuffer)>bytes) {
    [errors addObject:@{@"operation":@"stream-layout",@"status":@(status)}];
  } else {
    for (UInt32 i=0;i<list->mNumberBuffers;++i) {
      if (list->mBuffers[i].mNumberChannels>256) { [errors addObject:@{@"operation":@"channel-count"}];result=0;break; }
      result+=list->mBuffers[i].mNumberChannels;
    }
  }
  free(storage);return result;
}
int main(void) {
  @autoreleasepool {
    const char *ci=getenv("GITHUB_ACTIONS"),*commit=getenv("GITHUB_SHA");
    if (!ci || strcmp(ci,"true") || !commit || strlen(commit)!=40 || strspn(commit,"0123456789abcdef")!=40) return 2;
    errors=[NSMutableArray array];
    AudioDeviceID output=kAudioObjectUnknown,input=kAudioObjectUnknown;
    const bool outputQuery=read_property(kAudioObjectSystemObject,kAudioHardwarePropertyDefaultOutputDevice,kAudioObjectPropertyScopeGlobal,&output,sizeof output);
    const bool inputQuery=read_property(kAudioObjectSystemObject,kAudioHardwarePropertyDefaultInputDevice,kAudioObjectPropertyScopeGlobal,&input,sizeof input);
    UInt32 alive=0,buffer=0;Float64 rate=0;unsigned outputChannels=0,inputChannels=0;
    if (outputQuery && output!=kAudioObjectUnknown) {
      read_property(output,kAudioDevicePropertyDeviceIsAlive,kAudioObjectPropertyScopeGlobal,&alive,sizeof alive);
      read_property(output,kAudioDevicePropertyNominalSampleRate,kAudioObjectPropertyScopeGlobal,&rate,sizeof rate);
      read_property(output,kAudioDevicePropertyBufferFrameSize,kAudioObjectPropertyScopeGlobal,&buffer,sizeof buffer);
      outputChannels=channels(output,kAudioObjectPropertyScopeOutput);
    }
    if (inputQuery && input!=kAudioObjectUnknown) inputChannels=channels(input,kAudioObjectPropertyScopeInput);
#if defined(__arm64__)
    NSString *architecture=@"arm64";
#else
    NSString *architecture=@"x64";
#endif
    NSOperatingSystemVersion version=NSProcessInfo.processInfo.operatingSystemVersion;
    NSDictionary *report=@{@"protocol":@1,@"querySucceeded":@(errors.count==0),@"testCommit":@(commit),@"architecture":architecture,
      @"osVersion":[NSString stringWithFormat:@"%ld.%ld.%ld",version.majorVersion,version.minorVersion,version.patchVersion],
      @"defaultOutputPresent":@(outputQuery&&output!=kAudioObjectUnknown),@"outputAlive":@(alive!=0),
      @"outputChannels":@(outputChannels),@"outputSampleRate":@(rate),@"outputBufferFrames":@(buffer),
      @"defaultInputPresent":@(inputQuery&&input!=kAudioObjectUnknown),@"inputChannels":@(inputChannels),
      @"processTapAPIAvailable":@(dlsym(RTLD_DEFAULT,"AudioHardwareCreateProcessTap")!=nullptr),
      @"permissionQueried":@NO,@"permissionRequested":@NO,@"audioCaptured":@NO,@"audioPlayed":@NO,@"deviceSettingsChanged":@NO,
      @"errors":errors};
    NSData *json=[NSJSONSerialization dataWithJSONObject:report options:0 error:nullptr];if (!json) return 3;
    fwrite(json.bytes,1,json.length,stdout);fputc('\n',stdout);
    return errors.count?1:0;
  }
}
