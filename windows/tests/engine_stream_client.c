/* Receive a loopback-only Sunshine test stream without displaying, saving or
 * injecting input. Frame receipt is NOT proof that a decoder presented it. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "Limelight.h"

static volatile LONG frames, last_frame, last_keyframe, keyframes, terminated, stop_watchdog;
static volatile LONG64 bytes_received;

static int setup(int format, int width, int height, int fps, void *context, int flags) {
    (void)context; (void)flags;
    return format == VIDEO_FORMAT_H264 && width == 1280 && height == 720 && fps == 30 ? 0 : -1;
}

static int receive_frame(PDECODE_UNIT unit) {
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
    if (!file) return 0;
    fprintf(file, "{\"connected\":%s,\"frames\":%ld,\"lastFrame\":%lu,\"lastKeyframe\":%lu,\"keyframes\":%ld,\"bytes\":%lld,\"termination\":%ld}",
        connected ? "true" : "false", InterlockedCompareExchange(&frames, 0, 0),
        (unsigned long)InterlockedCompareExchange(&last_frame, 0, 0),
        (unsigned long)InterlockedCompareExchange(&last_keyframe, 0, 0), InterlockedCompareExchange(&keyframes, 0, 0),
        (long long)InterlockedCompareExchange64(&bytes_received, 0, 0), InterlockedCompareExchange(&terminated, 0, 0));
    fclose(file);
    return MoveFileExA(temporary, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
}

int main(int argc, char **argv) {
    if (argc != 8 || (strncmp(argv[3], "rtsp://127.0.0.1:", 17) != 0 &&
                      strncmp(argv[3], "rtspenc://127.0.0.1:", 20) != 0)) {
        fputs("Expected loopback test session arguments\n", stderr);
        return 2;
    }
    SERVER_INFORMATION server;
    STREAM_CONFIGURATION config;
    DECODER_RENDERER_CALLBACKS video;
    CONNECTION_LISTENER_CALLBACKS listener;
    LiInitializeServerInformation(&server);
    LiInitializeStreamConfiguration(&config);
    LiInitializeVideoCallbacks(&video);
    LiInitializeConnectionCallbacks(&listener);
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
    int result = LiStartConnection(&server, &config, &listener, &video, NULL, NULL, 0, NULL, 0);
    if (result == 0) {
        while (!InterlockedCompareExchange(&terminated, 0, 0) && GetFileAttributesA(argv[7]) == INVALID_FILE_ATTRIBUTES) {
            if (!report(argv[6], 1)) { result = 4; break; }
            Sleep(100);
        }
        LiStopConnection();
    }
    InterlockedExchange(&stop_watchdog, 1);
    WaitForSingleObject(timer, 2000);
    CloseHandle(timer);
    report(argv[6], 0);
    return result != 0 || InterlockedCompareExchange(&terminated, 0, 0) != 0 ? 1 : 0;
}
