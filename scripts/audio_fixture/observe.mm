// Disposable CI only: observe one verified sibling tone process. No PCM leaves
// the callback. This fixture is not shipped and does not change default devices.
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits.h>
#include <libproc.h>
#include <mutex>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

struct Observation {
  uint64_t samples=0, windows=0, callbacks=0, invalid=0, empty=0;
  double low=0, high=0, rms=0;
};
static Observation current;
static std::mutex observation_lock;
static std::atomic<bool> finished{false};
static unsigned rate, window_size, window_count;
static double low_re, low_im, high_re, high_im, squares;
static AudioObjectID tap=0, aggregate=0;
static AudioDeviceIOProcID io=nullptr;
static bool started=false;

static void require(bool valid, const char *stage) {
  if (!valid) { printf("{\"event\":\"error\",\"stage\":\"%s\"}\n",stage);fflush(stdout);_exit(3); }
}
static void check(OSStatus status,const char *stage) {
  if (status!=noErr) {
    printf("{\"event\":\"error\",\"stage\":\"%s\",\"status\":%d}\n",stage,(int)status);fflush(stdout);_exit(3);
  }
}
static void property(AudioObjectID object,AudioObjectPropertySelector selector,void *result,UInt32 expected) {
  AudioObjectPropertyAddress address={selector,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
  UInt32 size=expected;check(AudioObjectGetPropertyData(object,&address,0,nullptr,&size,result),"property");
  require(size==expected,"property-size");
}
static bool identity(pid_t pid,pid_t owner,const char *file,uint64_t sec,uint64_t usec) {
  struct proc_bsdinfo info={};char path[PROC_PIDPATHINFO_MAXSIZE]={};
  return proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof info)==sizeof info && info.pbi_pid==(uint32_t)pid &&
    info.pbi_ppid==(uint32_t)owner && info.pbi_uid==getuid() && info.pbi_ruid==getuid() &&
    info.pbi_start_tvsec==sec && info.pbi_start_tvusec==usec &&
    proc_pidpath(pid,path,sizeof path)>0 && !strcmp(path,file);
}
static OSStatus receive(AudioObjectID device,const AudioTimeStamp *now,const AudioBufferList *input,
                        const AudioTimeStamp *input_time,AudioBufferList *output,
                        const AudioTimeStamp *output_time,void *context) {
  (void)device;(void)now;(void)input_time;(void)output;(void)output_time;(void)context;
  std::lock_guard<std::mutex> lock(observation_lock);++current.callbacks;
  if (!input || !input->mNumberBuffers) { ++current.empty;return noErr; }
  bool interleaved=input->mNumberBuffers==1 && input->mBuffers[0].mNumberChannels==2;
  bool planar=input->mNumberBuffers==2 && input->mBuffers[0].mNumberChannels==1 && input->mBuffers[1].mNumberChannels==1;
  if (!interleaved && !planar) { ++current.invalid;return noErr; }
  const AudioBuffer &first=input->mBuffers[0];
  unsigned stride=interleaved?2:1;
  if (!first.mData || !first.mDataByteSize) { ++current.empty;return noErr; }
  if (first.mDataByteSize%(stride*sizeof(float)) ||
      (planar && (!input->mBuffers[1].mData || input->mBuffers[1].mDataByteSize!=first.mDataByteSize))) {
    ++current.invalid;return noErr;
  }
  const float *left=(const float *)first.mData;
  const float *right=interleaved?left+1:(const float *)input->mBuffers[1].mData;
  for (unsigned i=0;i<first.mDataByteSize/(stride*sizeof(float));++i) {
    double value=(left[stride*i]+right[stride*i])*.5;
    if (!std::isfinite(value)) { ++current.invalid;return noErr; }
    double angle=6.2831853071795864769*window_count/rate;
    low_re+=value*std::cos(angle*1000);low_im+=value*std::sin(angle*1000);
    high_re+=value*std::cos(angle*1600);high_im+=value*std::sin(angle*1600);squares+=value*value;
    ++current.samples;
    if (++window_count==window_size) {
      current.low=2*std::hypot(low_re,low_im)/window_size;
      current.high=2*std::hypot(high_re,high_im)/window_size;
      current.rms=std::sqrt(squares/window_size);++current.windows;
      window_count=0;low_re=low_im=high_re=high_im=squares=0;
    }
  }
  return noErr;
}
static void report(const char *event) {
  Observation value;{std::lock_guard<std::mutex> lock(observation_lock);value=current;}
  printf("{\"event\":\"%s\",\"rate\":%u,\"channels\":2,\"samples\":%llu,\"windows\":%llu,"
         "\"callbacks\":%llu,\"invalid\":%llu,\"empty\":%llu,\"low\":%.9f,\"high\":%.9f,\"rms\":%.9f}\n",
         event,rate,(unsigned long long)value.samples,(unsigned long long)value.windows,
         (unsigned long long)value.callbacks,(unsigned long long)value.invalid,(unsigned long long)value.empty,value.low,value.high,value.rms);
  fflush(stdout);
}
int main(int argc,char **argv) {
  @autoreleasepool {
    struct stat channel;const pid_t owner=getppid();
    require(argc==2 && getenv("GITHUB_ACTIONS") && !strcmp(getenv("GITHUB_ACTIONS"),"true") && owner>1 &&
      fstat(STDIN_FILENO,&channel)==0 && (S_ISFIFO(channel.st_mode)||S_ISSOCK(channel.st_mode)),"admission");
    char *end=nullptr;const long parsed=strtol(argv[1],&end,10);
    require(parsed>1 && parsed<=INT_MAX && end && !*end,"pid");const pid_t source=(pid_t)parsed;
    char root[PATH_MAX]={},expected[PATH_MAX]={};
    require(getenv("RUNNER_TEMP") && realpath(getenv("RUNNER_TEMP"),root) && strcmp(root,"/") &&
      getenv("CLIPRELAY_AUDIO_TONE_FIXTURE") && realpath(getenv("CLIPRELAY_AUDIO_TONE_FIXTURE"),expected),"source-path");
    NSString *prefix=[@(root) stringByAppendingString:@"/"];NSString *file=@(expected);
    require([file hasPrefix:prefix],"source-root");
    NSArray *parts=[[file substringFromIndex:prefix.length] pathComponents];
    require(parts.count==2 && [parts[0] hasPrefix:@"cliprelay-audio-fixture-"] &&
      [parts[1] isEqualToString:@"cliprelay-audio-tone"],"source-allowlist");
    struct proc_bsdinfo original={};
    require(proc_pidinfo(source,PROC_PIDTBSDINFO,0,&original,sizeof original)==sizeof original,"source-identity");
    require(identity(source,owner,expected,original.pbi_start_tvsec,original.pbi_start_tvusec),"source-owner");
    std::thread guard([=]{
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(90);
      while (!finished.load()) {
        if (getppid()!=owner || std::chrono::steady_clock::now()>=deadline ||
            !identity(source,owner,expected,original.pbi_start_tvsec,original.pbi_start_tvusec)) _exit(4);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
    });
    AudioObjectID process=0;UInt32 size=sizeof process;
    AudioObjectPropertyAddress translation={kAudioHardwarePropertyTranslatePIDToProcessObject,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    check(AudioObjectGetPropertyData(kAudioObjectSystemObject,&translation,sizeof source,&source,&size,&process),"translate-pid");
    require(size==sizeof process && process!=kAudioObjectUnknown,"audio-process");
    CATapDescription *description=[[CATapDescription alloc] initStereoMixdownOfProcesses:@[@(process)]];
    description.name=@"ClipRelay owned process output observer";description.UUID=NSUUID.UUID;
    [description setPrivate:YES];description.muteBehavior=CATapMuted;
    check(AudioHardwareCreateProcessTap(description,&tap),"create-tap");
    AudioStreamBasicDescription format={};property(tap,kAudioTapPropertyFormat,&format,sizeof format);
    require(format.mFormatID==kAudioFormatLinearPCM && (format.mFormatFlags&kAudioFormatFlagIsFloat) &&
      !(format.mFormatFlags&kAudioFormatFlagIsBigEndian) && format.mBitsPerChannel==32 && format.mChannelsPerFrame==2 &&
      (format.mSampleRate==44100 || format.mSampleRate==48000),"tap-format");
    rate=(unsigned)format.mSampleRate;window_size=rate/2;
    NSDictionary *properties=@{@kAudioAggregateDeviceNameKey:@"ClipRelay private output observer",
      @kAudioAggregateDeviceUIDKey:NSUUID.UUID.UUIDString,@kAudioAggregateDeviceIsPrivateKey:@YES,
      @kAudioAggregateDeviceTapAutoStartKey:@NO,@kAudioAggregateDeviceTapListKey:@[
        @{@kAudioSubTapUIDKey:description.UUID.UUIDString,@kAudioSubTapDriftCompensationKey:@YES}]};
    check(AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)properties,&aggregate),"create-aggregate");
    check(AudioDeviceCreateIOProcID(aggregate,receive,nullptr,&io),"create-io");
    check(AudioDeviceStart(aggregate,io),"start-io");started=true;
    report("ready");
    char command[16];bool valid=true;
    while (fgets(command,sizeof command,stdin)) {
      if (strcmp(command,"state\n")) {valid=false;break;}
      report("state");
    }
    if (started) check(AudioDeviceStop(aggregate,io),"stop-io");
    check(AudioDeviceDestroyIOProcID(aggregate,io),"destroy-io");
    check(AudioHardwareDestroyAggregateDevice(aggregate),"destroy-aggregate");
    check(AudioHardwareDestroyProcessTap(tap),"destroy-tap");
    finished.store(true);guard.join();
    printf("{\"event\":\"closed\",\"stopped\":true,\"ioDestroyed\":true,\"aggregateDestroyed\":true,\"tapDestroyed\":true}\n");fflush(stdout);
    return valid && current.invalid==0 ? 0 : 3;
  }
}
