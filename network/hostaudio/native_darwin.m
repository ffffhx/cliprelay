//go:build darwin && cgo

#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <stddef.h>
#include "native_darwin.h"

// The private tap is the entire mutation. No aggregate device, sample read,
// physical endpoint mute, volume, routing or persistent settings are written.
// Core Audio releases the process-owned tap if the worker dies unexpectedly.
static AudioObjectID ownedTap = kAudioObjectUnknown;
static NSUUID *ownedUUID;

static CATapDescription *readOwnedTap(OSStatus *status) {
    AudioObjectPropertyAddress address={kAudioTapPropertyDescription,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    void *raw=NULL;UInt32 size=sizeof(raw);
    *status=AudioObjectGetPropertyData(ownedTap,&address,0,NULL,&size,&raw);
    CATapDescription *description=CFBridgingRelease(raw);
    if(*status!=noErr || size!=sizeof(raw) || ![description isKindOfClass:[CATapDescription class]])return nil;
    return description;
}

int cr_audio_outputs(void) {
    AudioObjectPropertyAddress address={kAudioHardwarePropertyDevices,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    UInt32 size=0;
    if(AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,&address,0,NULL,&size)!=noErr || !size || size>4096 || size%sizeof(AudioDeviceID))return -1;
    AudioDeviceID devices[1024];
    if(AudioObjectGetPropertyData(kAudioObjectSystemObject,&address,0,NULL,&size,devices)!=noErr || size>sizeof(devices))return -1;
    int outputs=0;
    for(UInt32 i=0;i<size/sizeof(AudioDeviceID);i++){
        AudioObjectPropertyAddress streams={kAudioDevicePropertyStreamConfiguration,kAudioObjectPropertyScopeOutput,kAudioObjectPropertyElementMain};
        UInt32 bytes=0;
        if(AudioObjectGetPropertyDataSize(devices[i],&streams,0,NULL,&bytes)!=noErr || bytes<offsetof(AudioBufferList,mBuffers) || bytes>65536)return -1;
        AudioBufferList *list=calloc(1,bytes);if(!list)return -1;
        const UInt32 capacity=bytes;
        OSStatus status=AudioObjectGetPropertyData(devices[i],&streams,0,NULL,&bytes,list);
        if(status!=noErr || bytes>capacity || bytes<offsetof(AudioBufferList,mBuffers) || list->mNumberBuffers>32 ||
            offsetof(AudioBufferList,mBuffers)+list->mNumberBuffers*sizeof(AudioBuffer)>bytes){free(list);return -1;}
        BOOL present=NO;for(UInt32 j=0;j<list->mNumberBuffers;j++)present|=list->mBuffers[j].mNumberChannels>0;
        if(present)outputs++;
        free(list);
    }
    return outputs<=32?outputs:-1;
}

int cr_audio_healthy(void) {
    @autoreleasepool {
        if(ownedTap==kAudioObjectUnknown || !ownedUUID)return 0;
        OSStatus status=noErr;CATapDescription *description=readOwnedTap(&status);
        return status==noErr && description &&
            [description.UUID isEqual:ownedUUID] && description.isPrivate && description.isExclusive &&
            description.processes.count==0 && description.muteBehavior==CATapMuted;
    }
}

int cr_audio_start(void) {
    @autoreleasepool {
        if(ownedTap!=kAudioObjectUnknown)return 0;
        CATapDescription *description=[[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
        description.name=@"ClipRelay session speaker mute";
        description.UUID=[NSUUID UUID];description.private=YES;description.muteBehavior=CATapMuted;
        ownedUUID=description.UUID;
        OSStatus status=AudioHardwareCreateProcessTap(description,&ownedTap);
        if(status!=noErr){if(ownedTap==kAudioObjectUnknown)ownedUUID=nil;return 0;}
        return cr_audio_healthy();
    }
}

int cr_audio_stop(void) {
    @autoreleasepool {
        if(ownedTap==kAudioObjectUnknown)return 1;
        OSStatus status=noErr;CATapDescription *description=readOwnedTap(&status);
        if(status==kAudioHardwareBadObjectError || (description && ![description.UUID isEqual:ownedUUID])){
            // Object IDs can be reused; a replacement is never ours to destroy.
            ownedTap=kAudioObjectUnknown;ownedUUID=nil;return 1;
        }
        if(status!=noErr || !description)return 0;
        status=AudioHardwareDestroyProcessTap(ownedTap);
        if(status!=noErr && status!=kAudioHardwareBadObjectError)return 0;
        // A successful destroy or a missing object is authoritative cleanup.
        ownedTap=kAudioObjectUnknown;ownedUUID=nil;return 1;
    }
}
