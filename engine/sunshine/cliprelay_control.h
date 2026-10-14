// SPDX-License-Identifier: GPL-3.0-only
// ClipRelay's live capture state. Kept independent of Sunshine/Windows for tests.
#pragma once

#include <algorithm>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

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
  };

  struct display_snapshot {
    std::uint64_t revision = 0, generation = 0, request_id = 0;
    std::vector<std::string> displays;
    std::optional<display_geometry> capture;
    std::vector<stream_state> streams;
    std::string phase = "idle", requested, result, error;
  };

  // Capture/encode callbacks and the authenticated HTTP thread share this registry.
  // An accepted request is NOT proof of capture. Only a real encoded frame can
  // complete it; dummy frames, delayed packets and stale display instances cannot.
  class display_control {
  public:
    void catalog(std::vector<std::string> names) {
      names.erase(std::remove(names.begin(), names.end(), ""), names.end());
      std::lock_guard lock(mutex_);
      if (state_.displays != names) {
        state_.displays = std::move(names);
        ++state_.revision;
      }
    }

    void add_stream(void *key, std::string owner, int width, int height) {
      if (!key || owner.size() != 64 || width <= 0 || height <= 0) return;
      std::lock_guard lock(mutex_);
      streams_[key] = {std::move(owner), ++next_stream_, 0, width, height, 0, 0};
      ++state_.revision;
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
    std::string request(const std::string &id, std::uint64_t revision) {
      std::lock_guard lock(mutex_);
      if (revision != state_.revision) return "stale";
      if (!capture_running_ || streams_.empty()) return "not_streaming";
      if (state_.result == "pending") return "busy";
      if (std::find(state_.displays.begin(), state_.displays.end(), id) == state_.displays.end()) return "display_unavailable";
      queued_ = true;
      state_.requested = id;
      state_.result = "pending";
      state_.error.clear();
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
      auto stream = streams_.find(key);
      if (!capture_running_ || stream == streams_.end()) return;
      auto &s = stream->second;
      if (s.generation != state_.generation || s.minimum_frame == 0 || frame < s.minimum_frame || s.first_frame != 0) return;
      s.first_frame = frame;
      ++state_.revision;
      if (!queued_ && state_.result == "pending" && state_.capture && state_.capture->id == state_.requested) {
        state_.result = "applied";
        state_.error.clear();
      }
    }

    display_snapshot snapshot() const {
      std::lock_guard lock(mutex_);
      auto copy = state_;
      bool ready = false;
      for (auto const &[key, stream] : streams_) {
        copy.streams.push_back(stream);
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
        ++state_.revision;
      }
    }
    mutable std::mutex mutex_;
    display_snapshot state_;
    std::map<void *, stream_state> streams_;
    std::uint64_t next_stream_ = 0;
    bool queued_ = false, capture_running_ = false;
  };

  inline display_control displays;
}
