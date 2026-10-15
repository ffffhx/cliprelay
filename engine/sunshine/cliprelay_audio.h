// SPDX-License-Identifier: GPL-3.0-only
// Windows process loopback. No endpoint volume, mute, routing or format writes.
#pragma once
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <wrl/client.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <vector>

namespace cliprelay {
  namespace process_audio_detail {
    using Microsoft::WRL::ComPtr;
    // Public AUDIOCLIENT_ACTIVATION_PARAMS ABI, unavailable in some MinGW SDKs.
    // https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params
    struct parameters { UINT32 activation = 1; DWORD pid = 0; UINT32 mode = 0; };
    static_assert(sizeof(parameters) == 12);

    class activation final: public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
      std::atomic<ULONG> references_ {1};
    public:
      HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
      HRESULT status = E_PENDING;
      ComPtr<IAudioClient> client;
      parameters params;
      ~activation() { if (ready) CloseHandle(ready); }
      ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
      ULONG STDMETHODCALLTYPE Release() override {
        ULONG remaining = --references_;
        if (!remaining) delete this;
        return remaining;
      }
      HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (id == __uuidof(IUnknown) || id == __uuidof(IActivateAudioInterfaceCompletionHandler))
          *output = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
        else if (id == __uuidof(IAgileObject)) *output = static_cast<IAgileObject *>(this);
        else return E_NOINTERFACE;
        AddRef();
        return S_OK;
      }
      HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation *operation) override {
        HRESULT result = E_FAIL;
        ComPtr<IUnknown> value;
        status = operation->GetActivateResult(&result, &value);
        if (SUCCEEDED(status)) status = result;
        if (SUCCEEDED(status)) status = value.As(&client);
        SetEvent(ready);
        return S_OK;
      }
    };

    inline HRESULT activate(DWORD pid, bool include, ComPtr<IAudioClient> &client) {
      ComPtr<activation> callback;
      callback.Attach(new activation());
      if (!callback->ready) return HRESULT_FROM_WIN32(GetLastError());
      callback->params.pid = pid;
      callback->params.mode = include ? 0 : 1;
      PROPVARIANT params {};
      params.vt = VT_BLOB;
      params.blob.cbSize = sizeof(callback->params);
      params.blob.pBlobData = reinterpret_cast<BYTE *>(&callback->params);
      ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
      HRESULT result = ActivateAudioInterfaceAsync(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &params, callback.Get(), &operation);
      if (FAILED(result)) return result;
      // Windows holds the completion handler until the asynchronous operation
      // ends, including after this bounded caller wait has timed out.
      if (WaitForSingleObject(callback->ready, 5000) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
      if (SUCCEEDED(callback->status)) client = callback->client;
      return callback->status;
    }
  }

  class process_audio {
    process_audio_detail::ComPtr<IAudioClient> client_;
    process_audio_detail::ComPtr<IAudioCaptureClient> capture_;
    HANDLE event_ = nullptr;
    std::vector<float> buffered_;
    std::size_t cursor_ = 0;
    std::chrono::steady_clock::time_point last_packet_ {};
    bool continuous_ = false;
    UINT32 rate_ = 0, channels_ = 0;
  public:
    process_audio() = default;
    process_audio(const process_audio &) = delete;
    process_audio &operator=(const process_audio &) = delete;
    ~process_audio() {
      if (client_) client_->Stop();
      capture_.Reset(); client_.Reset();
      if (event_) CloseHandle(event_);
    }
    HRESULT init(DWORD pid, bool include, UINT32 rate, UINT32 channels, bool continuous) {
      if (client_ || !pid || rate != 48000 || channels != 2) return E_INVALIDARG;
      // Stereo is the negotiated ClipRelay default. Other layouts continue to
      // use the existing backend and cannot advertise host-only mute yet.
      HRESULT status = process_audio_detail::activate(pid, include, client_);
      if (FAILED(status)) return status;
      event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      if (!event_) return HRESULT_FROM_WIN32(GetLastError());
      WAVEFORMATEX format {WAVE_FORMAT_IEEE_FLOAT, static_cast<WORD>(channels), rate, rate * channels * 4, static_cast<WORD>(channels * 4), 32, 0};
      status = client_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 1000000, 0, &format, nullptr);
      if (FAILED(status)) return status;
      status = client_->GetService(IID_PPV_ARGS(&capture_));
      if (FAILED(status)) return status;
      status = client_->SetEventHandle(event_);
      if (FAILED(status)) return status;
      rate_ = rate; channels_ = channels; continuous_ = continuous;
      buffered_.reserve(rate * channels); // At most one second, including excess packets.
      return client_->Start();
    }
    bool healthy() const {
      return last_packet_ != std::chrono::steady_clock::time_point {} &&
        std::chrono::steady_clock::now() - last_packet_ < std::chrono::seconds(1);
    }
    // S_OK: one PCM frame; S_FALSE: no frame within 20 ms; failure: recreate.
    // Silence generated on timeout never establishes capture health.
    HRESULT read(std::vector<float> &output) {
      if (!capture_ || output.empty() || output.size() > rate_ * channels_ / 10) return E_INVALIDARG;
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(20);
      if (cursor_) {
        buffered_.erase(buffered_.begin(), buffered_.begin() + cursor_);
        cursor_ = 0;
      }
      while (buffered_.size() < output.size()) {
        UINT32 packet = 0;
        HRESULT status = capture_->GetNextPacketSize(&packet);
        if (FAILED(status)) { last_packet_ = {}; return status; }
        if (!packet) {
          if (std::chrono::steady_clock::now() >= deadline) {
            if (!continuous_) return S_FALSE;
            buffered_.resize(output.size(), 0);
            break;
          }
          DWORD waited = WaitForSingleObject(event_, 5);
          if (waited != WAIT_OBJECT_0 && waited != WAIT_TIMEOUT) { last_packet_ = {}; return E_FAIL; }
          continue;
        }
        BYTE *data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        status = capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(status)) { last_packet_ = {}; return status; }
        if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) buffered_.clear();
        const std::size_t samples = static_cast<std::size_t>(frames) * channels_;
        bool invalid = !frames || samples > rate_ * channels_ || buffered_.size() + samples > rate_ * channels_ ||
          (!data && !(flags & AUDCLNT_BUFFERFLAGS_SILENT));
        if (!invalid) {
          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) buffered_.resize(buffered_.size() + samples, 0);
          else buffered_.insert(buffered_.end(), reinterpret_cast<float *>(data), reinterpret_cast<float *>(data) + samples);
        }
        status = capture_->ReleaseBuffer(frames);
        if (FAILED(status) || invalid) { last_packet_ = {}; return FAILED(status) ? status : E_FAIL; }
        last_packet_ = std::chrono::steady_clock::now();
      }
      std::copy_n(buffered_.begin(), output.size(), output.begin());
      cursor_ = output.size();
      return S_OK;
    }
  };
}
