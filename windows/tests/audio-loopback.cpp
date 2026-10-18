// Read-only endpoint inventory first. Audio experiments must explicitly select
// the existing Steam virtual speaker and never alter the default-device route.
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#include <cstdio>
#include <string>
#include <vector>
#include <stdexcept>
#include <cmath>
#include <chrono>
#include <atomic>
#include "../../engine/sunshine/cliprelay_audio.h"
using Microsoft::WRL::ComPtr;
static void check(HRESULT result,const char* operation) {if(FAILED(result))throw std::runtime_error(std::string(operation)+" HRESULT "+std::to_string((unsigned long)result));}
static std::string utf8(const wchar_t* value) {
    if(!value)return "";int length=WideCharToMultiByte(CP_UTF8,0,value,-1,nullptr,0,nullptr,nullptr);
    std::string output(length,'\0');WideCharToMultiByte(CP_UTF8,0,value,-1,output.data(),length,nullptr,nullptr);output.resize(length-1);return output;
}
static std::string quoted(const std::string& value) {
    std::string output="\"";
    for(unsigned char c:value) {if(c=='"'||c=='\\')output+='\\';if(c<32){char encoded[7];std::snprintf(encoded,7,"\\u%04x",c);output+=encoded;}else output+=c;}
    return output+'"';
}
struct endpoint {ComPtr<IMMDevice> device;std::wstring id;std::string name;bool isDefault=false;};
static std::vector<endpoint> endpoints() {
    ComPtr<IMMDeviceEnumerator> enumerator;check(CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,IID_PPV_ARGS(&enumerator)),"enumerator");
    ComPtr<IMMDevice> current;std::wstring defaultId;
    if(SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender,eConsole,&current))) {LPWSTR id=nullptr;check(current->GetId(&id),"default id");defaultId=id;CoTaskMemFree(id);}
    ComPtr<IMMDeviceCollection> devices;check(enumerator->EnumAudioEndpoints(eRender,DEVICE_STATE_ACTIVE,&devices),"endpoints");UINT count;check(devices->GetCount(&count),"count");
    if(count>64)throw std::runtime_error("too many endpoints");std::vector<endpoint> result;
    for(UINT index=0;index<count;index++) {
        endpoint value;check(devices->Item(index,&value.device),"device");LPWSTR id=nullptr;check(value.device->GetId(&id),"id");value.id=id;CoTaskMemFree(id);value.isDefault=value.id==defaultId;
        ComPtr<IPropertyStore> properties;check(value.device->OpenPropertyStore(STGM_READ,&properties),"properties");PROPVARIANT name;PropVariantInit(&name);
        check(properties->GetValue(PKEY_Device_FriendlyName,&name),"name");if(name.vt==VT_LPWSTR)value.name=utf8(name.pwszVal);PropVariantClear(&name);result.push_back(value);
    }
    return result;
}
static UINT active_sessions(endpoint& device,bool diagnostic=false,DWORD capturePid=0) {
    ComPtr<IAudioSessionManager2> manager;check(device.device->Activate(__uuidof(IAudioSessionManager2),CLSCTX_ALL,nullptr,(void**)&manager),"session manager");
    ComPtr<IAudioSessionEnumerator> sessions;check(manager->GetSessionEnumerator(&sessions),"sessions");int count;check(sessions->GetCount(&count),"session count");
    if(count>256)throw std::runtime_error("too many audio sessions");UINT active=0;
    for(int index=0;index<count;index++) {
        ComPtr<IAudioSessionControl> control;check(sessions->GetSession(index,&control),"session");AudioSessionState state;check(control->GetState(&state),"session state");
        if(state!=AudioSessionStateActive)continue;ComPtr<IAudioSessionControl2> control2;check(control.As(&control2),"session identity");DWORD pid;HRESULT identity=control2->GetProcessId(&pid);check(identity,"session PID");if(pid!=GetCurrentProcessId() && !(capturePid && pid==capturePid && identity==S_OK)){
            active++;if(diagnostic)std::fprintf(stderr,"foreign session PID=%lu own=%lu identity=0x%08lx\n",(unsigned long)pid,(unsigned long)GetCurrentProcessId(),(unsigned long)identity);
        }
    }
    return active;
}
static int inventory() {
    auto devices=endpoints();bool first=true;std::printf("[");
    for(auto& device:devices) {
        ComPtr<IAudioEndpointVolume> volume;check(device.device->Activate(__uuidof(IAudioEndpointVolume),CLSCTX_ALL,nullptr,(void**)&volume),"volume");
        BOOL mute;float scalar;DWORD hardware;check(volume->GetMute(&mute),"mute");check(volume->GetMasterVolumeLevelScalar(&scalar),"scalar");check(volume->QueryHardwareSupport(&hardware),"hardware");
        std::printf("%s{\"name\":%s,\"default\":%s,\"mute\":%s,\"scalar\":%.6f,\"hardware\":%lu,\"activeSessions\":%u}",first?"":",",quoted(device.name).c_str(),device.isDefault?"true":"false",mute?"true":"false",scalar,(unsigned long)hardware,active_sessions(device));first=false;
    }
    std::printf("]\n");return 0;
}
static endpoint steam_speaker() {
    auto devices=endpoints();std::vector<endpoint> matches;
    for(auto& device:devices)if(device.name.find("Steam Streaming Speakers")!=std::string::npos)matches.push_back(device);
    if(matches.size()!=1)throw std::runtime_error("require exactly one existing Steam Streaming Speakers endpoint");
    return matches[0];
}
static ComPtr<IAudioEndpointVolume> endpoint_volume(endpoint& device) {
    ComPtr<IAudioEndpointVolume> volume;check(device.device->Activate(__uuidof(IAudioEndpointVolume),CLSCTX_ALL,nullptr,(void**)&volume),"volume");return volume;
}
struct restore_mute {
    ComPtr<IAudioEndpointVolume> volume;BOOL original;
    ~restore_mute(){if(volume)volume->SetMute(original,nullptr);}
};
struct streams {
    ComPtr<IAudioClient> capture,render;
    ~streams(){if(capture)capture->Stop();if(render)render->Stop();}
};
struct process_handle {HANDLE value=nullptr;~process_handle(){if(value)CloseHandle(value);}};
static int probe(bool physical,bool perProcess=false,bool toneOnly=false,DWORD capturePid=0) {
    // Process-loopback creates a capture session on the tone's endpoint after
    // rendering starts. Only the exact engine created by this fixture may be
    // ignored; all unrelated active sessions still abort the experiment.
    process_handle engine;
    if(capturePid) {
        if(!toneOnly)throw std::runtime_error("capture PID requires tone fixture");
        engine.value=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,capturePid);
        if(!engine.value || WaitForSingleObject(engine.value,0)!=WAIT_TIMEOUT)throw std::runtime_error("capture engine is not running");
    }
    endpoint device;
    if(physical) {for(auto& candidate:endpoints())if(candidate.isDefault)device=candidate;if(!device.device)throw std::runtime_error("no default endpoint");}
    else {device=steam_speaker();if(device.isDefault)throw std::runtime_error("refusing to test the current default device");}
    auto volume=endpoint_volume(device);BOOL original;DWORD hardware;check(volume->GetMute(&original),"original mute");check(volume->QueryHardwareSupport(&hardware),"hardware");
    float scalar;check(volume->GetMasterVolumeLevelScalar(&scalar),"endpoint level");
    if(!physical && hardware!=0)throw std::runtime_error("fixture requires a software-only virtual endpoint");
    if(!physical && active_sessions(device,false,capturePid))throw std::runtime_error("virtual endpoint has another active session");
    if(physical && (!(hardware&ENDPOINT_HARDWARE_SUPPORT_MUTE) || scalar>.05f || original || active_sessions(device)))throw std::runtime_error("physical fixture requires hardware mute, volume <=5%, initially unmuted and no other active audio session");
    restore_mute recovery{volume,original};
    // The parent records the identity and original state before authorizing the
    // bounded experiment, then can restore this exact endpoint after a crash.
    std::printf("{\"ready\":true,\"id\":%s,\"mute\":%s,\"hardware\":%lu}\n",quoted(utf8(device.id.c_str())).c_str(),original?"true":"false",(unsigned long)hardware);std::fflush(stdout);
    char input[8];if(!std::fgets(input,sizeof(input),stdin)||std::string(input)!="run\n")return 3;
    streams audio;
    cliprelay::process_audio processAudio;
    if(perProcess)check(processAudio.init(GetCurrentProcessId(),true,48000,2,false),"process capture init");
    else if(!toneOnly)check(device.device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,(void**)&audio.capture),"capture client");
    check(device.device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,(void**)&audio.render),"render client");
    WAVEFORMATEX format{WAVE_FORMAT_IEEE_FLOAT,2,48000,48000*8,8,32,0};
    DWORD conversion=AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM|AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    if(!perProcess && !toneOnly)check(audio.capture->Initialize(AUDCLNT_SHAREMODE_SHARED,conversion|AUDCLNT_STREAMFLAGS_LOOPBACK,1000000,0,&format,nullptr),"capture init");
    check(audio.render->Initialize(AUDCLNT_SHAREMODE_SHARED,conversion,1000000,0,&format,nullptr),"render init");
    ComPtr<IAudioRenderClient> renderer;check(audio.render->GetService(IID_PPV_ARGS(&renderer)),"render service");
    ComPtr<IAudioCaptureClient> capture;if(!perProcess && !toneOnly)check(audio.capture->GetService(IID_PPV_ARGS(&capture)),"capture service");
    ComPtr<ISimpleAudioVolume> ownVolume;check(audio.render->GetService(IID_PPV_ARGS(&ownVolume)),"own session volume");
    check(ownVolume->SetMasterVolume(1,nullptr),"own volume");check(ownVolume->SetMute(FALSE,nullptr),"own mute");
    UINT capacity;check(audio.render->GetBufferSize(&capacity),"capacity");
    if(!perProcess && !toneOnly)check(audio.capture->Start(),"capture start");check(audio.render->Start(),"render start");
    constexpr double pi=3.14159265358979323846;unsigned long long rendered=0,captured=0;double amplitudes[3]{};UINT counts[3]{};
    for(int stage=0;stage<3;stage++) {
        check(volume->SetMute(stage==1?TRUE:original,nullptr),"stage mute");
        if(toneOnly){std::printf("{\"stage\":%d}\n",stage);std::fflush(stdout);}
        double sine=0,cosine=0;auto started=std::chrono::steady_clock::now();
        while(std::chrono::steady_clock::now()-started<std::chrono::milliseconds(toneOnly?3500:900)) {
            UINT padding;check(audio.render->GetCurrentPadding(&padding),"padding");if(padding>capacity)throw std::runtime_error("invalid padding");
            UINT frames=capacity-padding;
            if(frames) {
                BYTE* bytes=nullptr;check(renderer->GetBuffer(frames,&bytes),"render buffer");float* values=(float*)bytes;
                for(UINT f=0;f<frames;f++){float value=(float)((physical?.0001:.005)*std::sin(2*pi*1000*rendered++/48000));values[2*f]=values[2*f+1]=value;}
                check(renderer->ReleaseBuffer(frames,0),"render release");
            }
            auto measure=[&](const float* values,UINT frames,bool silent) {
                bool active=std::chrono::steady_clock::now()-started>=std::chrono::milliseconds(200);
                for(UINT f=0;f<frames;f++) {
                    double angle=2*pi*1000*captured++/48000;
                    if(active){double value=silent?0:(values[2*f]+values[2*f+1])*.5;sine+=value*std::sin(angle);cosine+=value*std::cos(angle);counts[stage]++;}
                }
            };
            UINT packet=0;
            if(perProcess) {
                std::vector<float> frame(480);auto status=processAudio.read(frame);check(status,"process capture read");
                if(status==S_OK){if(!processAudio.healthy())throw std::runtime_error("process capture has no fresh packet");measure(frame.data(),240,false);}
            } else if(!toneOnly)check(capture->GetNextPacketSize(&packet),"next packet");
            int drain=0;
            while(packet) {
                if(++drain>128)throw std::runtime_error("capture overrun");BYTE* bytes=nullptr;UINT frames;DWORD flags;
                check(capture->GetBuffer(&bytes,&frames,&flags,nullptr,nullptr),"capture buffer");
                measure(reinterpret_cast<float*>(bytes),frames,(flags&AUDCLNT_BUFFERFLAGS_SILENT)!=0);
                check(capture->ReleaseBuffer(frames),"capture release");check(capture->GetNextPacketSize(&packet),"next packet");
            }
            Sleep(perProcess?1:5);
            if(engine.value && WaitForSingleObject(engine.value,0)!=WAIT_TIMEOUT)throw std::runtime_error("capture engine exited");
            if(active_sessions(device,true,capturePid))throw std::runtime_error("another audio session started; aborting and restoring");
        }
        amplitudes[stage]=counts[stage]?2*std::sqrt(sine*sine+cosine*cosine)/counts[stage]:0;
        if(!physical && steam_speaker().isDefault)throw std::runtime_error("default endpoint changed during fixture");
    }
    check(volume->SetMute(original,nullptr),"restore mute");BOOL restored;check(volume->GetMute(&restored),"verify restore");
    std::printf("{\"before\":%.9f,\"muted\":%.9f,\"after\":%.9f,\"samples\":[%u,%u,%u],\"restored\":%s}\n",amplitudes[0],amplitudes[1],amplitudes[2],counts[0],counts[1],counts[2],restored==original?"true":"false");
    return restored==original?0:4;
}
static int restore_endpoint(const char* mute,const char* expected) {
    if(std::string(mute)!="0" && std::string(mute)!="1")return 2;
    endpoint device;for(auto& candidate:endpoints())if(utf8(candidate.id.c_str())==expected)device=candidate;
    if(!device.device)throw std::runtime_error("recovery endpoint identity mismatch");
    auto volume=endpoint_volume(device);BOOL original=std::string(mute)=="1";check(volume->SetMute(original,nullptr),"recovery mute");BOOL actual;check(volume->GetMute(&actual),"recovery verify");return actual==original?0:4;
}
int main(int argc,char** argv) {
    HRESULT initialized=CoInitializeEx(nullptr,COINIT_MULTITHREADED);if(FAILED(initialized))return 2;
    int result=2;try {
        if(argc==2 && std::string(argv[1])=="--list")result=inventory();
        else if(argc==2 && std::string(argv[1])=="--probe-steam")result=probe(false);
        else if(argc==2 && std::string(argv[1])=="--probe-quiet-default")result=probe(true);
        else if(argc==2 && std::string(argv[1])=="--probe-process-steam")result=probe(false,true);
        else if(argc==2 && std::string(argv[1])=="--tone-steam")result=probe(false,false,true);
        else if(argc==3 && std::string(argv[1])=="--tone-steam") {
            size_t end=0;unsigned long pid=std::stoul(argv[2],&end);
            if(end!=std::string(argv[2]).size() || !pid)throw std::runtime_error("invalid capture PID");
            result=probe(false,false,true,static_cast<DWORD>(pid));
        }
        else if(argc==4 && std::string(argv[1])=="--restore-mute")result=restore_endpoint(argv[2],argv[3]);
    }catch(const std::exception& e){std::fprintf(stderr,"%s\n",e.what());}
    CoUninitialize();return result;
}
