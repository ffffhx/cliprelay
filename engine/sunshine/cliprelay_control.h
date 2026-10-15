// SPDX-License-Identifier: GPL-3.0-only
// ClipRelay's live capture state. Kept independent of Sunshine/Windows for tests.
#pragma once

#include <algorithm>
#include <cstdint>
#include <chrono>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>
#include "cliprelay_input.h"

namespace cliprelay {
  struct display_geometry {
    std::string id;
    int x = 0, y = 0, width = 0, height = 0;
    int desktop_x = 0, desktop_y = 0, desktop_width = 0, desktop_height = 0;
  };

  struct stream_state {
    std::string owner; // SHA-256 of the paired client's DER certificate, never its PEM/key.
    std::uint64_t id = 0, generation = 0;
    int width = 0, height = 0;
    std::int64_t first_frame = 0;
    std::int64_t minimum_frame = 0;
    std::string audio_capture;
    std::uint64_t audio_generation = 0;
    std::int64_t audio_encoded_ms = 0;
    bool audio_ready = false;
  };

  struct display_snapshot {
    std::uint64_t revision = 0, generation = 0, request_id = 0;
    std::vector<std::string> displays;
    std::optional<display_geometry> capture;
    std::vector<stream_state> streams;
    std::string phase = "idle", requested, result, error;
    std::uint64_t request_stream = 0;
    std::uint32_t input_epoch = 0;
  };

  // Capture/encode callbacks and the authenticated HTTP thread share this registry.
  // An accepted request is NOT proof of capture. Only a real encoded frame can
  // complete it; dummy frames, delayed packets and stale display instances cannot.
  class display_control {
  public:
    static std::int64_t monotonic_ms() {
      return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    }
    void catalog(std::vector<std::string> names) {
      names.erase(std::remove(names.begin(), names.end(), ""), names.end());
      std::lock_guard lock(mutex_);
      if (state_.displays != names) {
        state_.displays = std::move(names);
        ++state_.revision;
      }
    }

    std::uint64_t add_stream(void *key, std::string owner, int width, int height) {
      if (!key || owner.size() != 64 || width <= 0 || height <= 0) return 0;
      std::lock_guard lock(mutex_);
      stream_state stream;
      stream.owner = std::move(owner); stream.id = ++next_stream_;
      stream.width = width; stream.height = height;
      streams_[key] = std::move(stream);
      ++state_.revision;
      return next_stream_;
    }

    void remove_stream(void *key) {
      std::lock_guard lock(mutex_);
      if (streams_.erase(key)) ++state_.revision;
      if (streams_.empty()) {
        capture_running_ = false;
        state_.capture.reset();
        fail_locked("disconnected");
      }
    }

    // Optimistic concurrency prevents a stale picker from switching a different
    // screen after hotplug/reordering. The capture thread resolves the ID AGAIN.
    std::string request(const std::string &id, std::uint64_t revision, std::uint64_t stream = 0,
                        std::uint32_t epoch = 0, std::shared_ptr<input_selection> selection = {}) {
      std::lock_guard lock(mutex_);
      if (revision != state_.revision) return "stale";
      if (!capture_running_ || streams_.empty()) return "not_streaming";
      if (state_.result == "pending") return "busy";
      if (std::find(state_.displays.begin(), state_.displays.end(), id) == state_.displays.end()) return "display_unavailable";
      if ((stream || epoch) && !selection) return "input_not_paused";
      if (selection && (!selection->valid.load() || !epoch || !(epoch & 1) || streams_.size() != 1 || streams_.begin()->second.id != stream)) return "input_not_exclusive";
      selection_ = std::move(selection);
      queued_ = true;
      state_.requested = id;
      state_.result = "pending";
      state_.error.clear();
      state_.request_stream = stream; state_.input_epoch = epoch;
      ++state_.request_id;
      ++state_.revision;
      return "accepted";
    }

    bool pending() const {
      std::lock_guard lock(mutex_);
      return queued_;
    }

    int take_selection(const std::vector<std::string> &fresh, int fallback) {
      std::lock_guard lock(mutex_);
      if (!queued_) return fallback;
      queued_ = false;
      if (selection_ && !selection_->valid.load()) { fail_locked("input_unavailable"); return fallback; }
      auto found = std::find(fresh.begin(), fresh.end(), state_.requested);
      if (found == fresh.end()) {
        fail_locked("display_unavailable");
        return fallback;
      }
      return static_cast<int>(found - fresh.begin());
    }

    std::uint64_t begin_capture(display_geometry geometry) {
      std::lock_guard lock(mutex_);
      ++state_.generation;
      ++state_.revision;
      capture_running_ = geometry.width > 0 && geometry.height > 0 && !geometry.id.empty();
      state_.capture = capture_running_ ? std::optional(geometry) : std::nullopt;
      if (selection_ && !selection_->valid.load()) fail_locked("input_unavailable");
      if (!capture_running_) fail_locked("capture_unavailable");
      // A request may arrive while an unrelated capture is being constructed.
      // Leave queued requests alone so the capture loop can process them next.
      else if (!queued_ && state_.result == "pending" && geometry.id != state_.requested) fail_locked("capture_mismatch");
      return state_.generation;
    }

    void invalidate() {
      std::lock_guard lock(mutex_);
      if (capture_running_) ++state_.revision;
      capture_running_ = false;
      state_.capture.reset();
    }

    void selection_failed() {
      std::lock_guard lock(mutex_);
      fail_locked("capture_unavailable");
    }

    void bind(void *key, std::uint64_t generation) {
      std::lock_guard lock(mutex_);
      auto stream = streams_.find(key);
      if (stream == streams_.end()) return; // encoder probes are not live streams
      stream->second.generation = generation;
      stream->second.minimum_frame = 0;
      stream->second.first_frame = 0;
    }

    // Called only after converting an actual capture image (never the dummy).
    void real_frame(void *key, std::uint64_t generation, std::int64_t frame) {
      std::lock_guard lock(mutex_);
      auto stream = streams_.find(key);
      if (!capture_running_ || generation != state_.generation || stream == streams_.end() || frame <= 0) return;
      auto &s = stream->second;
      if (s.generation == generation && s.minimum_frame == 0) s.minimum_frame = frame;
    }

    // Called when an encoded packet is actually queued, using its PTS. A codec
    // accepting input without producing output must never announce readiness.
    void encoded(void *key, std::int64_t frame) {
      std::lock_guard lock(mutex_);
      if (selection_ && !selection_->valid.load()) fail_locked("input_unavailable");
      auto stream = streams_.find(key);
      if (!capture_running_ || stream == streams_.end()) return;
      auto &s = stream->second;
      if (s.generation != state_.generation || s.minimum_frame == 0 || frame < s.minimum_frame || s.first_frame != 0) return;
      s.first_frame = frame;
      ++state_.revision;
      if (!queued_ && state_.result == "pending" && state_.capture && state_.capture->id == state_.requested) {
        state_.result = "applied";
        state_.error.clear();
        selection_.reset();
      }
    }

    std::uint64_t begin_audio(void *key, bool independent) {
      std::lock_guard lock(mutex_);
      auto stream = streams_.find(key);
      if (stream == streams_.end()) return 0;
      auto &s = stream->second;
      s.audio_capture = independent ? "process" : "endpoint";
      s.audio_generation = ++next_audio_;
      s.audio_encoded_ms = 0;
      return s.audio_generation;
    }

    // A queued PCM buffer carries its capture generation through encoding.
    // Old buffers cannot make a restarted or stopped capture ready again.
    void encoded_audio(void *key, std::uint64_t generation, bool healthy, std::int64_t now = monotonic_ms()) {
      std::lock_guard lock(mutex_);
      auto stream = streams_.find(key);
      if (stream == streams_.end() || generation == 0 || generation != stream->second.audio_generation) return;
      stream->second.audio_encoded_ms = healthy ? now : 0;
    }

    void end_audio(void *key, std::uint64_t generation) {
      std::lock_guard lock(mutex_);
      auto stream = streams_.find(key);
      if (stream == streams_.end() || generation == 0 || generation != stream->second.audio_generation) return;
      stream->second.audio_capture.clear();
      stream->second.audio_generation = 0;
      stream->second.audio_encoded_ms = 0;
    }

    display_snapshot snapshot(std::int64_t now = monotonic_ms()) const {
      std::lock_guard lock(mutex_);
      auto copy = state_;
      bool ready = false;
      for (auto const &[key, stream] : streams_) {
        copy.streams.push_back(stream);
        auto &audio = copy.streams.back();
        audio.audio_ready = audio.audio_capture == "process" && audio.audio_generation != 0 && audio.audio_encoded_ms > 0 &&
          now >= audio.audio_encoded_ms && now - audio.audio_encoded_ms < 2000;
        ready |= capture_running_ && stream.generation == state_.generation && stream.first_frame > 0;
      }
      copy.phase = state_.result == "pending" ? "switching" : (ready ? "active" : (streams_.empty() ? "idle" : "starting"));
      return copy;
    }

  private:
    void fail_locked(const std::string &error) {
      if (state_.result == "pending") {
        state_.result = "failed";
        state_.error = error;
        queued_ = false;
        selection_.reset();
        ++state_.revision;
      }
    }
    mutable std::mutex mutex_;
    display_snapshot state_;
    std::map<void *, stream_state> streams_;
    std::uint64_t next_stream_ = 0;
    std::uint64_t next_audio_ = 0;
    bool queued_ = false, capture_running_ = false;
    std::shared_ptr<input_selection> selection_;
  };

  inline display_control displays;

  // Same budget convention as the RTSP negotiation: include FEC, audio and
  // transport overhead, then respect the host's encoder limit. All inputs here
  // are negotiated host values except the bounded user budget.
  inline int video_bitrate(int budget, int fec, int audio, int maximum) {
    if (fec >= 0 && fec <= 80) budget /= 100.f / (100 - fec);
    budget -= std::min(audio, budget / 5);
    budget -= std::min(500, budget / 10);
    return maximum > 0 ? std::min(budget, maximum) : budget;
  }

  struct bitrate_state {
    std::string owner;
    std::uint64_t id = 0, revision = 1, request_id = 0;
    int budget = 0, video = 0, requested = 0, target = 0;
    int fec = 0, audio = 0, maximum = 0;
    bool supported = false;
    std::int64_t minimum_frame = 0, applied_frame = 0;
    std::string result, error;
  };

  class bitrate_control {
  public:
    void add(void *key, std::uint64_t id, std::string owner, int budget, int video, int fec, int audio, int maximum) {
      if (!key || !id || owner.size() != 64 || video <= 0) return;
      std::lock_guard lock(mutex_);
      bitrate_state s;
      s.id = id; s.owner = std::move(owner); s.budget = budget;
      s.video = maximum > 0 ? std::min(video, maximum) : video;
      s.fec = fec; s.audio = audio; s.maximum = maximum;
      streams_[key] = std::move(s);
    }

    void remove(void *key) {
      std::lock_guard lock(mutex_);
      streams_.erase(key);
    }

    // A display restart uses the last CONFIRMED bitrate. An in-flight update
    // cannot silently become the starting configuration of another encoder.
    int begin_encoder(void *key) {
      std::lock_guard lock(mutex_);
      auto it = streams_.find(key);
      if (it == streams_.end()) return 0;
      auto &s = it->second;
      if (s.result == "pending") fail_locked(s, "encoder_restarted");
      s.supported = false;
      ++s.revision;
      return s.video;
    }

    void support(void *key, bool supported) {
      std::lock_guard lock(mutex_);
      auto it = streams_.find(key);
      if (it == streams_.end()) return;
      it->second.supported = supported;
      ++it->second.revision;
    }

    std::string request(std::uint64_t id, const std::string &owner, std::uint64_t revision, int budget) {
      std::lock_guard lock(mutex_);
      for (auto &[key, s] : streams_) {
        if (s.id != id || s.owner != owner) continue;
        if (s.revision != revision) return "stale";
        if (!s.supported) return "unsupported_encoder";
        if (s.result == "pending") return "busy";
        if (budget < 500 || budget > 150000) return "invalid_bitrate";
        s.requested = budget;
        s.target = video_bitrate(budget, s.fec, s.audio, s.maximum);
        s.result = "pending";
        s.error.clear();
        s.minimum_frame = s.applied_frame = 0;
        ++s.request_id;
        ++s.revision;
        return "accepted";
      }
      return "not_streaming";
    }

    std::optional<bitrate_state> take(void *key, std::int64_t frame) {
      std::lock_guard lock(mutex_);
      auto it = streams_.find(key);
      if (it == streams_.end()) return std::nullopt;
      auto &s = it->second;
      if (s.result != "pending" || s.minimum_frame || frame <= 0) return std::nullopt;
      s.minimum_frame = frame;
      return s;
    }

    void encoded(void *key, std::int64_t frame) {
      std::lock_guard lock(mutex_);
      auto it = streams_.find(key);
      if (it == streams_.end()) return;
      auto &s = it->second;
      if (s.result != "pending" || !s.minimum_frame || frame < s.minimum_frame) return;
      s.budget = s.requested; s.video = s.target; s.applied_frame = frame;
      s.result = "applied";
      ++s.revision;
    }

    void fail(void *key, std::uint64_t request, const std::string &error) {
      std::lock_guard lock(mutex_);
      auto it = streams_.find(key);
      if (it != streams_.end() && it->second.request_id == request && it->second.result == "pending")
        fail_locked(it->second, error);
    }

    std::optional<bitrate_state> state(void *key) const {
      std::lock_guard lock(mutex_);
      auto it = streams_.find(key);
      return it == streams_.end() ? std::nullopt : std::optional(it->second);
    }

    std::vector<bitrate_state> snapshot() const {
      std::lock_guard lock(mutex_);
      std::vector<bitrate_state> result;
      for (const auto &[key, s] : streams_) result.push_back(s);
      return result;
    }

  private:
    static void fail_locked(bitrate_state &s, const std::string &error) {
      s.result = "failed"; s.error = error; s.minimum_frame = 0;
      ++s.revision;
    }
    mutable std::mutex mutex_;
    std::map<void *, bitrate_state> streams_;
  };

  inline bitrate_control bitrates;
}
