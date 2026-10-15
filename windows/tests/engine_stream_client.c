/* Receive a loopback-only Sunshine test stream without displaying, saving or
 * injecting input. Frame receipt is NOT proof that a decoder presented it. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdbool.h>
#include "Limelight.h"
#include "opus_multistream.h"

static volatile LONG frames, last_frame, last_keyframe, keyframes, terminated, stop_watchdog;
static volatile LONG64 bytes_received;
static volatile LONG64 last_received_ms, maximum_gap_ms;
static volatile LONG pattern_ready;
static volatile LONG audio_packets, audio_errors;
static volatile LONG64 audio_samples;
static CRITICAL_SECTION audio_gate;
static double audio_tone, tone_sine, tone_cosine;
static uint64_t tone_index;
static unsigned tone_count;
static HMODULE opus_module;
static OpusMSDecoder *audio_decoder;
static OpusMSDecoder *(*opus_create)(opus_int32,int,int,int,const unsigned char*,int*);
static int (*fixture_opus_decode)(OpusMSDecoder*,const unsigned char*,opus_int32,float*,int,int);
static void (*opus_destroy)(OpusMSDecoder*);

// Fixture-only access to the existing encrypted control sender. This mode can
// emit pause/resume envelopes only; no keyboard/mouse/gamepad data is accepted.
extern int sendInputPacketOnControlStream(unsigned char*, int, uint8_t, uint32_t, bool);
static int input_commands(void) {
    HANDLE pipe = GetStdHandle(STD_INPUT_HANDLE);
    DWORD available = 0, received = 0;
    if (GetFileType(pipe) != FILE_TYPE_PIPE || !PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL) || available > 64) return 0;
    if (available < 8) return 1;
    unsigned char command[8], packet[16] = {0,0,0,12,0x4e,0x49,0x52,0x43,0,0,0,0,0,0,0,0};
    if (!ReadFile(pipe, command, 8, &received, NULL) || received != 8 || command[4] || command[5] || command[6] ||
        (command[7] != 1 && command[7] != 2) || !(command[0] || command[1] || command[2] || command[3])) return 0;
    memcpy(packet + 8, command, 4); packet[12] = command[7];
    return sendInputPacketOnControlStream(packet, sizeof packet, 0, 1, false) >= 0;
}

static int audio_setup(int configuration, const POPUS_MULTISTREAM_CONFIGURATION config, void *context, int flags) {
    (void)context; (void)flags;
    if (configuration != AUDIO_CONFIGURATION_STEREO || config->sampleRate != 48000 || config->channelCount != 2 || config->streams != 1 || config->coupledStreams != 1) return -1;
    int error = 0;
    audio_decoder = opus_create(config->sampleRate, config->channelCount, config->streams, config->coupledStreams, config->mapping, &error);
    return audio_decoder && error == OPUS_OK ? 0 : -1;
}

static void audio_cleanup(void) {
    if (audio_decoder) opus_destroy(audio_decoder);
    audio_decoder = NULL;
}

static void audio_receive(char *data, int length) {
    float pcm[5760 * 2];
    int samples = fixture_opus_decode(audio_decoder, (const unsigned char *)data, length, pcm, 5760, 0);
    if (samples <= 0) { InterlockedIncrement(&audio_errors); return; }
    InterlockedIncrement(&audio_packets);
    InterlockedAdd64(&audio_samples, samples);
    EnterCriticalSection(&audio_gate);
    for (int i = 0; i < samples; ++i) {
        double angle = 6.2831853071795864769 * (double)(tone_index++ % 48) / 48;
        double value = (pcm[2 * i] + pcm[2 * i + 1]) * .5;
        tone_sine += value * sin(angle); tone_cosine += value * cos(angle);
        if (++tone_count == 24000) {
            audio_tone = 2 * sqrt(tone_sine * tone_sine + tone_cosine * tone_cosine) / tone_count;
            tone_sine = tone_cosine = 0; tone_count = 0;
        }
    }
    LeaveCriticalSection(&audio_gate);
    // Decoded PCM is discarded. No playback or audio file is produced.
}

static int load_opus(void) {
    char path[MAX_PATH];
    DWORD length = GetModuleFileNameA(NULL, path, sizeof path);
    if (!length || length >= sizeof path) return 0;
    char *slash = strrchr(path, '\\');
    const char *name = "cliprelay-test-opus.dll";
    if (!slash || (size_t)(slash + 1 - path) + strlen(name) >= sizeof path) return 0;
    strcpy(slash + 1, name);
    opus_module = LoadLibraryExA(path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!opus_module) return 0;
    opus_create = (void *)GetProcAddress(opus_module, "opus_multistream_decoder_create");
    fixture_opus_decode = (void *)GetProcAddress(opus_module, "opus_multistream_decode_float");
    opus_destroy = (void *)GetProcAddress(opus_module, "opus_multistream_decoder_destroy");
    return opus_create && fixture_opus_decode && opus_destroy;
}

// Optional synthetic changing content for a bounded bitrate test. This owns its
// window, never activates it, and disappears when the receiver exits. No input
// is sent to another application and no desktop pixels are retained.
static LRESULT CALLBACK pattern_proc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    return DefWindowProcW(window, message, wp, lp);
}

static DWORD WINAPI pattern_thread(void *unused) {
    (void)unused;
    WNDCLASSW type = {0};
    type.lpfnWndProc = pattern_proc;
    type.hInstance = GetModuleHandleW(NULL);
    type.lpszClassName = L"ClipRelayBitrateTestPattern";
    if (!RegisterClassW(&type)) return 1;
    int width = GetSystemMetrics(SM_CXSCREEN) * 3 / 4;
    int height = GetSystemMetrics(SM_CYSCREEN) * 3 / 4;
    HWND window = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        type.lpszClassName, L"ClipRelay bitrate test", WS_POPUP | WS_BORDER,
        (GetSystemMetrics(SM_CXSCREEN) - width) / 2, (GetSystemMetrics(SM_CYSCREEN) - height) / 2,
        width, height, NULL, NULL, type.hInstance, NULL);
    if (!window) return 2;
    ShowWindow(window, SW_SHOWNOACTIVATE);
    uint32_t *pixels = malloc(640 * 360 * sizeof(uint32_t));
    if (!pixels) { DestroyWindow(window); return 3; }
    BITMAPINFO bitmap = {0};
    bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bitmap.bmiHeader.biWidth = 640; bitmap.bmiHeader.biHeight = -360;
    bitmap.bmiHeader.biPlanes = 1; bitmap.bmiHeader.biBitCount = 32;
    bitmap.bmiHeader.biCompression = BI_RGB;
    uint32_t random = 0x43525031;
    InterlockedExchange(&pattern_ready, 1);
    while (!InterlockedCompareExchange(&stop_watchdog, 0, 0)) {
        MSG message;
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
        for (int i = 0; i < 640 * 360; ++i) {
            random ^= random << 13; random ^= random >> 17; random ^= random << 5;
            pixels[i] = random & 0x00ffffff;
        }
        HDC dc = GetDC(window);
        StretchDIBits(dc, 0, 0, width, height, 0, 0, 640, 360, pixels, &bitmap, DIB_RGB_COLORS, SRCCOPY);
        ReleaseDC(window, dc);
        Sleep(33);
    }
    free(pixels);
    DestroyWindow(window);
    InterlockedExchange(&pattern_ready, 0);
    return 0;
}

static int setup(int format, int width, int height, int fps, void *context, int flags) {
    (void)context; (void)flags;
    return format == VIDEO_FORMAT_H264 && width == 1280 && height == 720 && fps == 30 ? 0 : -1;
}

static int receive_frame(PDECODE_UNIT unit) {
    LONG64 now = (LONG64)GetTickCount64();
    LONG64 previous = InterlockedExchange64(&last_received_ms, now);
    if (previous) {
        LONG64 gap = now - previous, maximum;
        do {
            maximum = InterlockedCompareExchange64(&maximum_gap_ms, 0, 0);
            if (gap <= maximum) break;
        } while (InterlockedCompareExchange64(&maximum_gap_ms, gap, maximum) != maximum);
    }
    InterlockedIncrement(&frames);
    InterlockedExchange(&last_frame, unit->frameNumber);
    InterlockedAdd64(&bytes_received, unit->fullLength);
    if (unit->frameType == FRAME_TYPE_IDR) {
        InterlockedExchange(&last_keyframe, unit->frameNumber);
        InterlockedIncrement(&keyframes);
    }
    return DR_OK;
}

static void connection_terminated(int error) {
    InterlockedExchange(&terminated, error == 0 ? 1 : error);
}

static void log_message(const char *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    vfprintf(stderr, format, arguments);
    va_end(arguments);
}

static DWORD WINAPI watchdog(void *unused) {
    (void)unused;
    for (int i = 0; i < 900 && !InterlockedCompareExchange(&stop_watchdog, 0, 0); i++) Sleep(100);
    if (!InterlockedCompareExchange(&stop_watchdog, 0, 0)) {
        InterlockedExchange(&terminated, -999);
        LiInterruptConnection();
    }
    return 0;
}

static int decode_hex(const char *text, char *result) {
    if (strlen(text) != 32) return 0;
    for (int i = 0; i < 16; i++) {
        char pair[3] = {text[i * 2], text[i * 2 + 1], 0}, *end;
        if (strspn(pair, "0123456789abcdefABCDEF") != 2) return 0;
        result[i] = (char)strtoul(pair, &end, 16);
        if (*end) return 0;
    }
    return 1;
}

static int report(const char *path, int connected) {
    char temporary[MAX_PATH * 2];
    if (snprintf(temporary, sizeof temporary, "%s.tmp", path) >= (int)sizeof temporary) return 0;
    FILE *file = fopen(temporary, "wb");
    if (!file) { perror("Opening receiver state"); return 0; }
    EnterCriticalSection(&audio_gate); double tone = audio_tone; LeaveCriticalSection(&audio_gate);
    fprintf(file, "{\"connected\":%s,\"frames\":%ld,\"lastFrame\":%lu,\"lastKeyframe\":%lu,\"keyframes\":%ld,\"bytes\":%lld,\"termination\":%ld,\"maxGapMs\":%lld,\"pattern\":%s,\"audioPackets\":%ld,\"audioSamples\":%lld,\"audioErrors\":%ld,\"audioTone\":%.9f}",
        connected ? "true" : "false", InterlockedCompareExchange(&frames, 0, 0),
        (unsigned long)InterlockedCompareExchange(&last_frame, 0, 0),
        (unsigned long)InterlockedCompareExchange(&last_keyframe, 0, 0), InterlockedCompareExchange(&keyframes, 0, 0),
        (long long)InterlockedCompareExchange64(&bytes_received, 0, 0), InterlockedCompareExchange(&terminated, 0, 0),
        (long long)InterlockedCompareExchange64(&maximum_gap_ms, 0, 0),
        InterlockedCompareExchange(&pattern_ready, 0, 0) ? "true" : "false",
        InterlockedCompareExchange(&audio_packets, 0, 0), (long long)InterlockedCompareExchange64(&audio_samples, 0, 0),
        InterlockedCompareExchange(&audio_errors, 0, 0), tone);
    if (fclose(file) != 0) { perror("Writing receiver state"); return 0; }
    // The Python reader can briefly hold the old file without delete sharing.
    // Keep atomic publication, but do not stop the stream for that read race.
    DWORD error = 0;
    for (int attempt = 0; attempt < 20; ++attempt) {
        if (MoveFileExA(temporary, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return 1;
        error = GetLastError();
        if (error != ERROR_SHARING_VIOLATION && error != ERROR_LOCK_VIOLATION && error != ERROR_ACCESS_DENIED) break;
        Sleep(10);
    }
    fprintf(stderr, "Publishing receiver state failed: %lu\n", (unsigned long)error);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 8 || argc > 11 || (strncmp(argv[3], "rtsp://127.0.0.1:", 17) != 0 &&
                      strncmp(argv[3], "rtspenc://127.0.0.1:", 20) != 0)) {
        fputs("Expected loopback test session arguments\n", stderr);
        return 2;
    }
    int use_pattern = 0, use_audio = 0, use_input_epochs = 0;
    for (int i = 8; i < argc; ++i) {
        if (!strcmp(argv[i], "--pattern") && !use_pattern) use_pattern = 1;
        else if (!strcmp(argv[i], "--audio") && !use_audio) use_audio = 1;
        else if (!strcmp(argv[i], "--input-epochs") && !use_input_epochs) use_input_epochs = 1;
        else return 2;
    }
    if (use_audio && !load_opus()) { fputs("Missing fixture Opus DLL\n", stderr); return 2; }
    InitializeCriticalSection(&audio_gate);
    SERVER_INFORMATION server;
    STREAM_CONFIGURATION config;
    DECODER_RENDERER_CALLBACKS video;
    CONNECTION_LISTENER_CALLBACKS listener;
    AUDIO_RENDERER_CALLBACKS audio;
    LiInitializeServerInformation(&server);
    LiInitializeStreamConfiguration(&config);
    LiInitializeVideoCallbacks(&video);
    LiInitializeConnectionCallbacks(&listener);
    LiInitializeAudioCallbacks(&audio);
    audio.init = audio_setup; audio.cleanup = audio_cleanup; audio.decodeAndPlaySample = audio_receive;
    server.address = "127.0.0.1";
    server.serverInfoAppVersion = argv[1];
    server.serverInfoGfeVersion = argv[2];
    server.rtspSessionUrl = argv[3];
    server.serverCodecModeSupport = 1;
    config.width = 1280; config.height = 720; config.fps = 30; config.bitrate = 5000;
    config.packetSize = 1024; config.streamingRemotely = STREAM_CFG_LOCAL;
    config.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
    config.supportedVideoFormats = VIDEO_FORMAT_H264;
    config.clientRefreshRateX100 = 3000;
    config.encryptionFlags = ENCFLG_ALL;
    if (!decode_hex(argv[4], config.remoteInputAesKey) || !decode_hex(argv[5], config.remoteInputAesIv)) return 2;
    video.setup = setup; video.submitDecodeUnit = receive_frame;
    video.capabilities = CAPABILITY_DIRECT_SUBMIT;
    listener.connectionTerminated = connection_terminated;
    listener.logMessage = log_message;
    HANDLE timer = CreateThread(NULL, 0, watchdog, NULL, 0, NULL);
    if (!timer) return 3;
    HANDLE pattern = NULL;
    if (use_pattern) {
        SetProcessDPIAware();
        pattern = CreateThread(NULL, 0, pattern_thread, NULL, 0, NULL);
    }
    int result = LiStartConnection(&server, &config, &listener, &video, use_audio ? &audio : NULL, NULL, 0, NULL, 0);
    if (result == 0) {
        while (!InterlockedCompareExchange(&terminated, 0, 0) && GetFileAttributesA(argv[7]) == INVALID_FILE_ATTRIBUTES) {
            if (use_input_epochs && !input_commands()) { result = 5; break; }
            if (!report(argv[6], 1)) { result = 4; break; }
            Sleep(100);
        }
        LiStopConnection();
    }
    InterlockedExchange(&stop_watchdog, 1);
    WaitForSingleObject(timer, 2000);
    CloseHandle(timer);
    if (pattern) { WaitForSingleObject(pattern, 2000); CloseHandle(pattern); }
    report(argv[6], 0);
    DeleteCriticalSection(&audio_gate);
    if (opus_module) FreeLibrary(opus_module);
    return result != 0 || InterlockedCompareExchange(&terminated, 0, 0) != 0 ? 1 : 0;
}
