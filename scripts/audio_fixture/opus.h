// SPDX-License-Identifier: GPL-3.0-or-later
// Included only by the disposable audio receiver, never the shipping viewer.
// Opus API: https://opus-codec.org/docs/opus_api-1.5/group__opus__multistream.html
#include <opus_multistream.h>
#include <math.h>
static OpusMSDecoder *audio_decoder;
static unsigned audio_packets, audio_errors, audio_windows, window_samples;
static uint64_t audio_samples, audio_at;
static double low_sin, low_cos, high_sin, high_cos, energy;
static double audio_low, audio_high, audio_rms;
// Count only fixed categories from the pinned native library's format strings.
// Never format its arguments: those may contain protocol/session credentials.
static atomic_uint audio_setups, audio_initial_packets, audio_resyncs;
static atomic_uint audio_decrypt_failures, audio_queue_overflows, audio_receive_failures;
static void audio_log(const char *format) {
  if (!format) return;
  if (strstr(format,"first audio packet")) atomic_fetch_add(&audio_initial_packets,1);
  else if (strstr(format,"audio resync")) atomic_fetch_add(&audio_resyncs,1);
  else if (strstr(format,"decrypt audio")) atomic_fetch_add(&audio_decrypt_failures,1);
  else if (strstr(format,"Audio packet queue overflow")) atomic_fetch_add(&audio_queue_overflows,1);
  else if (strstr(format,"Audio Receive:")) atomic_fetch_add(&audio_receive_failures,1);
}
static int audio_setup(int configuration, const POPUS_MULTISTREAM_CONFIGURATION config, void *context, int flags) {
  (void)context; (void)flags;
  atomic_fetch_add(&audio_setups,1);
  if (configuration!=AUDIO_CONFIGURATION_STEREO || config->sampleRate!=48000 || config->channelCount!=2 ||
      config->streams!=1 || config->coupledStreams!=1) return -1;
  int error=0;
  audio_decoder=opus_multistream_decoder_create(config->sampleRate,config->channelCount,config->streams,
                                               config->coupledStreams,config->mapping,&error);
  return audio_decoder && error==OPUS_OK ? 0 : -1;
}
static void audio_cleanup(void) {
  if (audio_decoder) opus_multistream_decoder_destroy(audio_decoder);
  audio_decoder=NULL;
}
static void audio_receive(char *data, int length) {
  float pcm[5760*2];
  // Missing packets/PLC are not evidence of captured samples.
  if (!data || length<=0 || length>65536 || !audio_decoder) {
    pthread_mutex_lock(&state_gate);++audio_errors;pthread_mutex_unlock(&state_gate);return;
  }
  const int samples=opus_multistream_decode_float(audio_decoder,(const unsigned char *)data,length,pcm,5760,0);
  pthread_mutex_lock(&state_gate);
  if (samples<=0) { ++audio_errors;pthread_mutex_unlock(&state_gate);return; }
  ++audio_packets;
  for (int i=0;i<samples;++i) {
    const double value=(pcm[2*i]+pcm[2*i+1])*.5;
    if (!isfinite(value)) { ++audio_errors;continue; }
    const double low=6.2831853071795864769*(audio_samples%48)/48;
    const double high=6.2831853071795864769*(audio_samples%30)/30;
    ++audio_samples;
    low_sin+=value*sin(low);low_cos+=value*cos(low);
    high_sin+=value*sin(high);high_cos+=value*cos(high);energy+=value*value;
    if (++window_samples==24000) {
      audio_low=2*hypot(low_sin,low_cos)/window_samples;
      audio_high=2*hypot(high_sin,high_cos)/window_samples;
      audio_rms=sqrt(energy/window_samples);
      low_sin=low_cos=high_sin=high_cos=energy=0;window_samples=0;
      ++audio_windows;audio_at=now_ms();
    }
  }
  pthread_mutex_unlock(&state_gate);
  // PCM is discarded; this receiver neither plays nor writes audio.
}
static void audio_progress(void) {
  printf("{\"received\":%u,\"decoded\":%u,\"color\":\"%s\",\"ageMs\":%llu,\"errors\":%d,"
         "\"audio\":{\"packets\":%u,\"samples\":%llu,\"windows\":%u,\"ageMs\":%llu,\"errors\":%u,"
         "\"low\":%.9f,\"high\":%.9f,\"rms\":%.9f,"
         "\"diagnostics\":{\"setups\":%u,\"firstPackets\":%u,\"resyncs\":%u,"
         "\"decryptFailures\":%u,\"queueOverflows\":%u,\"receiveFailures\":%u}}}\n",received,decoded,colors[color],
         (unsigned long long)(sampled_at?now_ms()-sampled_at:0),atomic_load(&decode_errors),audio_packets,
         (unsigned long long)audio_samples,audio_windows,(unsigned long long)(audio_at?now_ms()-audio_at:0),
         audio_errors,audio_low,audio_high,audio_rms,atomic_load(&audio_setups),atomic_load(&audio_initial_packets),
         atomic_load(&audio_resyncs),atomic_load(&audio_decrypt_failures),atomic_load(&audio_queue_overflows),atomic_load(&audio_receive_failures));
}
