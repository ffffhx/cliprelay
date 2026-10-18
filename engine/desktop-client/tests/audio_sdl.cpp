// Real SDL dummy output; inject one invalid-device call at the queue boundary.
// This tests renderer error propagation, not physical playback or hotplug.
#include "sdl.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <stdexcept>

static int pendingMs, queueCalls, injectedErrors;
static bool failNext;
static SDL_AudioDeviceID lastDevice;

extern "C" int LiGetPendingAudioDuration() { return pendingMs; }
extern "C" int __real_SDL_QueueAudio(SDL_AudioDeviceID, const void*, Uint32);
extern "C" int __wrap_SDL_QueueAudio(SDL_AudioDeviceID device, const void* data, Uint32 bytes)
{
    ++queueCalls;
    lastDevice = device;
    if (failNext) {
        failNext = false;
        if (SDL_GetAudioDeviceStatus(device) != SDL_AUDIO_PLAYING) {
            std::fputs("owned test device is not playing\n", stderr);
            std::abort();
        }
        // Exercise SDL's real invalid-device error without closing or corrupting
        // the renderer's device. All other calls use the real dummy output.
        int result = __real_SDL_QueueAudio(0, data, bytes);
        if (result >= 0 || !*SDL_GetError()) std::abort();
        ++injectedErrors;
        return result;
    }
    return __real_SDL_QueueAudio(device, data, bytes);
}

static void require(bool condition, const char* reason)
{
    if (!condition) throw std::runtime_error(reason);
}

static std::unique_ptr<SdlAudioRenderer> create()
{
    auto renderer = std::make_unique<SdlAudioRenderer>();
    OPUS_MULTISTREAM_CONFIGURATION config{};
    config.sampleRate = 48000; config.channelCount = 2;
    config.streams = 1; config.coupledStreams = 1; config.samplesPerFrame = 240;
    require(renderer->prepareForPlayback(&config), "prepare-failed");
    require(SDL_GetCurrentAudioDriver() && std::strcmp(SDL_GetCurrentAudioDriver(), "dummy") == 0,
            "unexpected-output-driver");
    std::memset(renderer->getAudioBuffer(nullptr), 0, 240 * 2 * sizeof(float));
    return renderer;
}

int main()
{
    require(SDL_setenv("SDL_AUDIODRIVER", "dummy", 1) == 0, "driver-selection-failed");
    try {
        auto renderer = create();
        constexpr int bytes = 240 * 2 * sizeof(float);
        require(renderer->submitAudio(bytes) && queueCalls == 1, "normal-queue-failed");
        require(renderer->submitAudio(0) && queueCalls == 1, "empty-buffer-queued");
        pendingMs = 31;
        require(renderer->submitAudio(bytes) && queueCalls == 1, "backpressure-regression");
        pendingMs = 0;
        failNext = true;
        require(!renderer->submitAudio(bytes), "queue-error-not-propagated");
        require(injectedErrors == 1 && queueCalls == 2, "fault-not-exercised");
        renderer.reset();
        require(!SDL_WasInit(SDL_INIT_AUDIO), "failed-renderer-not-cleaned");
        renderer = create();
        require(renderer->submitAudio(bytes) && queueCalls == 3, "reopened-output-failed");
        require(SDL_GetAudioDeviceStatus(lastDevice) == SDL_AUDIO_PLAYING, "reopened-output-not-playing");
        renderer.reset();
        require(!SDL_WasInit(SDL_INIT_AUDIO), "reopened-renderer-not-cleaned");
        std::puts("{\"passed\":true,\"driver\":\"dummy\",\"realQueueError\":true,\"queueCalls\":3,\"injectedErrors\":1,\"audioSubsystemReleased\":true,\"cases\":[\"normal-output-queue\",\"empty-buffer-skips-queue\",\"network-backpressure-skips-queue\",\"live-device-queue-error-propagated\",\"failed-renderer-releases-device\",\"fresh-renderer-queues-after-failure\"]}");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        if (SDL_WasInit(SDL_INIT_AUDIO)) return 3;
        return 2;
    }
}
