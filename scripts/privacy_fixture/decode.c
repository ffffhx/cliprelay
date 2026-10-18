// SPDX-License-Identifier: GPL-3.0-or-later
// Disposable CI receiver: encrypted loopback -> software H.264 decode -> only
// nine samples inside the fixture's central solid-color window. No input,
// playback, screenshots, bitstream files or decoded image files are produced.
// Decoder API: https://ffmpeg.org/doxygen/trunk/decode_video_8c-example.html
#include "Limelight.h"
#include <libavcodec/avcodec.h>
#include <libavutil/pixfmt.h>
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static AVCodecContext *decoder;
static AVFrame *image;
static AVPacket *packet;
static atomic_int stopped, finished, termination, decode_errors;
static pthread_mutex_t state_gate = PTHREAD_MUTEX_INITIALIZER;
static unsigned received, decoded, color;
static uint64_t sampled_at;
static const char *colors[] = {"mixed", "red", "green", "blue", "black"};
static pid_t owner;
static uint64_t deadline;

static uint64_t now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) _exit(2);
  return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static int line(char *output, size_t capacity) {
  size_t count = 0;
  const uint64_t end = now_ms() + 5000;
  while (count + 1 < capacity && now_ms() < end) {
    struct pollfd channel = {STDIN_FILENO, POLLIN, 0};
    if (poll(&channel, 1, 100) < 0) { if (errno == EINTR) continue; return 0; }
    if (!(channel.revents & POLLIN)) { if (channel.revents) return 0; continue; }
    char next;
    if (read(STDIN_FILENO, &next, 1) != 1) return 0;
    if (next == '\n') { output[count] = 0; return count > 0; }
    if ((unsigned char)next < 32 || (unsigned char)next > 126) return 0;
    output[count++] = next;
  }
  return 0;
}
static int hex_key(const char *value, char output[16]) {
  if (strlen(value) != 32 || strspn(value, "0123456789abcdef") != 32) return 0;
  for (int i = 0; i < 16; ++i) {
    char pair[3] = {value[2*i], value[2*i+1], 0};
    output[i] = (char)strtoul(pair, NULL, 16);
  }
  return 1;
}
static int version_quad(const char *value, int signed_revision) {
  for (int part=0;part<4;++part) {
    if (part==3 && signed_revision && *value=='-') ++value;
    int digits=0;
    while (*value>='0' && *value<='9') { ++value;if (++digits>6) return 0; }
    if (!digits) return 0;
    if (part==3) return *value==0;
    if (*value++!='.') return 0;
  }
  return 0;
}
static int setup(int format, int width, int height, int fps, void *context, int flags) {
  (void)context; (void)flags;
  if (format != VIDEO_FORMAT_H264 || width != 1280 || height != 720 || fps != 30) return -1;
  const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
  if (!codec || !(decoder = avcodec_alloc_context3(codec)) || !(image = av_frame_alloc()) || !(packet = av_packet_alloc())) return -1;
  decoder->thread_count = 1;
  return avcodec_open2(decoder, codec, NULL);
}
static unsigned pixel(unsigned y, unsigned u, unsigned v) {
  if (v > 180 && u < 140 && y > 30) return 1;
  if (u < 110 && v < 110 && y > 80) return 2;
  if (u > 180 && v < 160 && y > 20) return 3;
  if (y < 40 && u > 100 && u < 155 && v > 100 && v < 155) return 4;
  return 0;
}
static unsigned sample(void) {
  if (image->width != 1280 || image->height != 720 ||
      (image->format != AV_PIX_FMT_YUV420P && image->format != AV_PIX_FMT_YUVJ420P)) return 0;
  for (int i = 0; i < 3; ++i) if (!image->data[i] || image->linesize[i] <= 0) return 0;
  unsigned expected = 0;
  for (int dy = -4; dy <= 4; dy += 4) for (int dx = -4; dx <= 4; dx += 4) {
    int x = image->width / 2 + dx, y = image->height / 2 + dy;
    unsigned value = pixel(image->data[0][y*image->linesize[0]+x],
        image->data[1][(y/2)*image->linesize[1]+x/2], image->data[2][(y/2)*image->linesize[2]+x/2]);
    if (!value || (expected && expected != value)) return 0;
    expected = value;
  }
  return expected;
}
static int receive_frame(PDECODE_UNIT unit) {
  if (!decoder || unit->fullLength <= 0 || unit->fullLength > 16*1024*1024 || unit->frameNumber <= 0) return DR_NEED_IDR;
  av_packet_unref(packet);
  if (av_new_packet(packet, unit->fullLength) < 0) return DR_NEED_IDR;
  int offset = 0;
  for (PLENTRY piece = unit->bufferList; piece; piece = piece->next) {
    if (!piece->data || piece->length < 0 || piece->length > unit->fullLength - offset) return DR_NEED_IDR;
    memcpy(packet->data + offset, piece->data, piece->length); offset += piece->length;
  }
  if (offset != unit->fullLength) return DR_NEED_IDR;
  packet->pts = unit->frameNumber; packet->dts = unit->frameNumber;
  pthread_mutex_lock(&state_gate); received = unit->frameNumber; pthread_mutex_unlock(&state_gate);
  if (avcodec_send_packet(decoder, packet) < 0) { atomic_fetch_add(&decode_errors, 1); return DR_NEED_IDR; }
  for (;;) {
    const int result = avcodec_receive_frame(decoder, image);
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) break;
    if (result < 0 || image->pts <= 0 || image->pts > UINT32_MAX) { atomic_fetch_add(&decode_errors, 1); return DR_NEED_IDR; }
    const unsigned value = sample();
    pthread_mutex_lock(&state_gate);
    if ((unsigned)image->pts > decoded) { decoded = (unsigned)image->pts; color = value; sampled_at = now_ms(); }
    pthread_mutex_unlock(&state_gate);
    av_frame_unref(image);
  }
  return DR_OK;
}
static void cleanup(void) { av_packet_free(&packet); av_frame_free(&image); avcodec_free_context(&decoder); }
static void ended(int reason) { atomic_store(&termination, reason); atomic_store(&stopped, 1); }
static void stage_failed(int stage,int code) { printf("{\"event\":\"stage-failed\",\"stage\":%d,\"code\":%d}\n",stage,code);fflush(stdout); }
#ifdef CLIPRELAY_AUDIO_FIXTURE
static void audio_log(const char *format);
#endif
static void silent_log(const char *format, ...) {
#ifdef CLIPRELAY_AUDIO_FIXTURE
  audio_log(format);
#else
  (void)format;
#endif
}
static void *watch(void *ignored) {
  (void)ignored;
  while (!atomic_load(&finished)) {
    struct pollfd channel = {STDIN_FILENO, POLLIN, 0};
    int status = poll(&channel, 1, 100);
    if (getppid() != owner || now_ms() >= deadline || status > 0 || (status < 0 && errno != EINTR)) {
      atomic_store(&stopped, 1); LiInterruptConnection();
      for (int i = 0; i < 30 && !atomic_load(&finished); ++i) usleep(100000);
      if (!atomic_load(&finished)) _exit(3);
    }
  }
  return NULL;
}
#ifdef CLIPRELAY_AUDIO_FIXTURE
#include "../audio_fixture/opus.h"
#endif
int main(void) {
  struct stat channel;
  if (!getenv("GITHUB_ACTIONS") || strcmp(getenv("GITHUB_ACTIONS"), "true") || getppid() <= 1 ||
      fstat(STDIN_FILENO, &channel) != 0 || !(S_ISFIFO(channel.st_mode) || S_ISSOCK(channel.st_mode))) return 2;
  owner = getppid(); deadline = now_ms() + 120000;
  char version[64], gfe[64], url[256], key[64], iv[64];
  if (!line(version,sizeof version) || !line(gfe,sizeof gfe) || !line(url,sizeof url) || !line(key,sizeof key) || !line(iv,sizeof iv)) return 2;
  static const char prefix[] = "rtspenc://127.0.0.1:";
  // The pinned Sunshine engine advertises 7.1.431.-1, a signed final revision.
  if (!version_quad(version,1) || !version_quad(gfe,0) ||
      strncmp(url,prefix,sizeof(prefix)-1) != 0) return 2;
  const char *port = url + sizeof(prefix)-1;
  if (!*port || strlen(port)>5 || strspn(port,"0123456789")!=strlen(port) || strtol(port,NULL,10)<1 || strtol(port,NULL,10)>65535) return 2;
  SERVER_INFORMATION server; STREAM_CONFIGURATION config; DECODER_RENDERER_CALLBACKS video; CONNECTION_LISTENER_CALLBACKS listener;
  LiInitializeServerInformation(&server); LiInitializeStreamConfiguration(&config); LiInitializeVideoCallbacks(&video); LiInitializeConnectionCallbacks(&listener);
  server.address="127.0.0.1";server.serverInfoAppVersion=version;server.serverInfoGfeVersion=gfe;server.rtspSessionUrl=url;server.serverCodecModeSupport=1;
  config.width=1280;config.height=720;config.fps=30;config.bitrate=6000;config.packetSize=1024;config.streamingRemotely=STREAM_CFG_LOCAL;
  config.audioConfiguration=AUDIO_CONFIGURATION_STEREO;config.supportedVideoFormats=VIDEO_FORMAT_H264;config.clientRefreshRateX100=3000;config.encryptionFlags=ENCFLG_ALL;
  if (!hex_key(key,config.remoteInputAesKey) || !hex_key(iv,config.remoteInputAesIv)) return 2;
  memset(key,0,sizeof key);memset(iv,0,sizeof iv);
  video.setup=setup;video.cleanup=cleanup;video.submitDecodeUnit=receive_frame;video.capabilities=CAPABILITY_DIRECT_SUBMIT;
  listener.connectionTerminated=ended;listener.stageFailed=stage_failed;listener.logMessage=silent_log;
  av_log_set_level(AV_LOG_ERROR);
  pthread_t guard;if (pthread_create(&guard,NULL,watch,NULL) != 0) return 2;
#ifdef CLIPRELAY_AUDIO_FIXTURE
  AUDIO_RENDERER_CALLBACKS audio;
  LiInitializeAudioCallbacks(&audio);
  audio.init=audio_setup;audio.cleanup=audio_cleanup;audio.decodeAndPlaySample=audio_receive;
  const int result=LiStartConnection(&server,&config,&listener,&video,&audio,NULL,0,NULL,0);
#else
  const int result=LiStartConnection(&server,&config,&listener,&video,NULL,NULL,0,NULL,0);
#endif
  if (!result) {
    while (!atomic_load(&stopped)) {
      pthread_mutex_lock(&state_gate);
#ifdef CLIPRELAY_AUDIO_FIXTURE
      audio_progress();
#else
      printf("{\"received\":%u,\"decoded\":%u,\"color\":\"%s\",\"ageMs\":%llu,\"errors\":%d}\n",received,decoded,colors[color],
          (unsigned long long)(sampled_at?now_ms()-sampled_at:0),atomic_load(&decode_errors));
#endif
      pthread_mutex_unlock(&state_gate);fflush(stdout);usleep(100000);
    }
    LiStopConnection();
  }
  atomic_store(&finished,1);pthread_join(guard,NULL);cleanup();
  return result || atomic_load(&termination) ? 1 : 0;
}
