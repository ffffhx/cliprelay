// CI-only instrumentation for an owned, immutable shipping viewer. No PCM is
// retained. One private-pipe command causes a real SDL invalid-device error;
// the production Session alone must close, reopen and resume its renderer.
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <initializer_list>
#include <mach-o/dyld-interposing.h>
#include <mutex>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

// Public SDL2 C ABI; the opaque specs are forwarded without reading or changing
// their layout. Link the exact verified viewer's libSDL2.dylib, not a test SDL.
// https://wiki.libsdl.org/SDL2/SDL_OpenAudioDevice
// https://wiki.libsdl.org/SDL2/SDL_QueueAudio
extern "C" {
struct SDL_AudioSpec;
uint32_t SDL_OpenAudioDevice(const char*, int, const SDL_AudioSpec*, SDL_AudioSpec*, int);
void SDL_CloseAudioDevice(uint32_t);
int SDL_QueueAudio(uint32_t, const void*, uint32_t);
int SDL_GetAudioDeviceStatus(uint32_t);
const char* SDL_GetError(void);
}

static bool admitted = false;
static std::atomic<unsigned> generation{0}, active{0}, queuedGeneration{0};
static std::atomic<bool> injected{false};
static std::mutex eventMutex;
static unsigned events = 0;
static double started = 0;

static double now() {
    timespec value{};
    if (clock_gettime(CLOCK_MONOTONIC, &value)) std::_Exit(86);
    return value.tv_sec + value.tv_nsec / 1e9;
}
static void require(bool value) { if (!value) std::_Exit(86); }
static bool equals(const char* name, const char* value) {
    const char* actual = std::getenv(name);
    return actual && std::strcmp(actual, value) == 0;
}
static void emit(const char* event, unsigned device, unsigned gen, int result = 0, bool error = false) {
    std::lock_guard<std::mutex> lock(eventMutex);
    require(++events <= 64);
    char line[384];
    const int count = std::snprintf(line, sizeof(line),
        "{\"event\":\"%s\",\"pid\":%d,\"device\":%u,\"generation\":%u,\"result\":%d,\"errorPresent\":%s,\"elapsedMs\":%.0f}\n",
        event, getpid(), device, gen, result, error ? "true" : "false", (now() - started) * 1000);
    require(count > 0 && count < static_cast<int>(sizeof(line)));
    require(write(4, line, static_cast<size_t>(count)) == count);
}
__attribute__((constructor)) static void admit() {
    require(equals("GITHUB_ACTIONS", "true") && equals("GITHUB_REPOSITORY", "ffffhx/cliprelay"));
    char expectedParent[32];
    std::snprintf(expectedParent, sizeof(expectedParent), "%d", getppid());
    require(equals("CLIPRELAY_AUDIO_FAULT_OWNER", expectedParent));
    proc_bsdinfo parent{};
    require(proc_pidinfo(getppid(), PROC_PIDTBSDINFO, 0, &parent, sizeof(parent)) == static_cast<int>(sizeof(parent)));
    require(parent.pbi_uid == getuid());
    char executable[PROC_PIDPATHINFO_MAXSIZE], resolved[PATH_MAX], workspace[PATH_MAX];
    require(proc_pidpath(getpid(), executable, sizeof(executable)) > 0);
    const char* expected = std::getenv("CLIPRELAY_AUDIO_FAULT_VIEWER");
    const char* root = std::getenv("GITHUB_WORKSPACE");
    require(expected && root && realpath(expected, resolved) && realpath(root, workspace));
    require(std::strcmp(executable, resolved) == 0);
    char owned[PATH_MAX];
    const int length = std::snprintf(owned, sizeof(owned), "%s/.tools/audio-stream-mac/stream-viewer/runtime/ClipRelayStream.app/Contents/MacOS/Moonlight", workspace);
    require(length > 0 && length < static_cast<int>(sizeof(owned)) && std::strcmp(resolved, owned) == 0);
    for (int fd : {3, 4}) {
        struct stat info{};
        require(fstat(fd, &info) == 0 && (S_ISFIFO(info.st_mode) || S_ISSOCK(info.st_mode)));
        const int flags = fcntl(fd, F_GETFL);
        require(flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0);
        require(fcntl(fd, F_SETFD, FD_CLOEXEC) == 0);
        require(fcntl(fd, F_SETNOSIGPIPE, 1) == 0);
    }
    started = now();
    admitted = true;
    emit("ready", 0, 0);
}
static uint32_t openDevice(const char* name, int capture, const SDL_AudioSpec* wanted, SDL_AudioSpec* obtained, int changes) {
    const uint32_t device = SDL_OpenAudioDevice(name, capture, wanted, obtained, changes);
    if (admitted && !capture && device) {
        require(active.exchange(device) == 0);
        emit("opened", device, ++generation);
    }
    return device;
}
static void closeDevice(uint32_t device) {
    const unsigned gen = generation.load();
    const bool owned = admitted && device && device == active.load();
    SDL_CloseAudioDevice(device);
    if (owned) {
        require(active.exchange(0) == device);
        emit("closed", device, gen);
    }
}
static int queueAudio(uint32_t device, const void* bytes, uint32_t length) {
    if (admitted && !injected.load()) {
        char command = 0;
        const ssize_t count = read(3, &command, 1);
        require(count >= 0 || errno == EAGAIN || errno == EINTR);
        if (count == 1) {
            require(command == 'F' && now() - started < 120 && length && device == active.load());
            require(queuedGeneration.load() == generation.load() && SDL_GetAudioDeviceStatus(device) == 1);
            require(!injected.exchange(true));
            const int result = SDL_QueueAudio(0, bytes, length);
            const bool error = SDL_GetError() && *SDL_GetError();
            emit("injected", device, generation.load(), result, error);
            require(result < 0 && error);
            return result;
        }
    }
    const int result = SDL_QueueAudio(device, bytes, length);
    if (admitted && result == 0 && length && device == active.load()) {
        const unsigned gen = generation.load();
        if (queuedGeneration.exchange(gen) != gen) emit("queued", device, gen);
    }
    return result;
}
DYLD_INTERPOSE(openDevice, SDL_OpenAudioDevice)
DYLD_INTERPOSE(closeDevice, SDL_CloseAudioDevice)
DYLD_INTERPOSE(queueAudio, SDL_QueueAudio)
