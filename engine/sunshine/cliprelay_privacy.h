// SPDX-License-Identifier: GPL-3.0-only
// Private Mac capture-filter policy. Native process/window admission lives in
// the platform bridge; no public client can supply these native identities.
#pragma once
#include "cliprelay_control.h"
#include <set>

namespace cliprelay::privacy {
  struct window_identity {
    std::uint32_t id = 0, display = 0;
    bool operator==(const window_identity &) const = default;
  };
  struct process_identity {
    int pid = 0;
    std::uint64_t birth_sec = 0;
    std::uint32_t birth_usec = 0;
    std::vector<window_identity> windows;
    bool operator==(const process_identity &) const = default;
  };
  struct binding {
    std::string owner, lease;
    std::uint64_t stream = 0;
    bool operator==(const binding &) const = default;
  };
  enum class process_state { alive, dead, unknown };
  struct filter_state {
    std::uint64_t epoch = 1, generation = 0;
    std::int64_t first_frame = 0, expires_ms = 0;
    bool retained = false, authorized = false, ready = false;
    binding session;
    process_identity worker;
    std::string reason;
  };

  inline bool hex(const std::string &text, std::size_t length) {
    return text.size() == length && std::all_of(text.begin(), text.end(), [](char c) {
      return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
  }
  inline bool valid(const binding &value) {
    return hex(value.owner, 64) && hex(value.lease, 32) && value.stream && value.stream < (1ULL << 53);
  }
  inline bool valid(const process_identity &value) {
    if (value.pid <= 1 || !value.birth_sec || value.birth_usec >= 1000000 || value.windows.empty() || value.windows.size() > 16) return false;
    std::set<std::uint32_t> windows, displays;
    for (const auto &item : value.windows) {
      if (!item.id || !item.display || !windows.insert(item.id).second || !displays.insert(item.display).second) return false;
    }
    return true;
  }

  // Serializing these short policy calls never waits for AppKit, ScreenCaptureKit
  // or native process queries. Caller supplies an epoch with every observation
  // so delayed work cannot clear a newer lease or announce an obsolete source.
  class filter_control {
  public:
    std::string prepare(const binding &session, const process_identity &worker,
                        const display_snapshot &display, std::int64_t now) {
      std::lock_guard lock(mutex_);
      if (!valid(session) || !valid(worker) || now < 0) return "invalid";
      if (state_.retained) {
        if (state_.session != session || state_.worker != worker) return "busy";
        if (!state_.authorized || now >= deadline_) return "expired";
        return "accepted"; // A replay never restarts the filter or its timer.
      }
      if (!exclusive(display, session) || display.phase != "active" || !display.capture ||
          !display.generation || display.streams[0].generation != display.generation || display.streams[0].first_frame <= 0) return "not_streaming";
      ++state_.epoch;
      state_.retained = state_.authorized = true;
      state_.session = session;
      state_.worker = worker;
      state_.reason.clear();
      geometry_ = *display.capture;
      catalog_ = display.displays;
      original_generation_ = display.generation;
      deadline_ = now + 15000;
      ever_ready_ = false;
      return "accepted";
    }

    void source_started(std::uint64_t epoch, std::uint64_t generation) {
      std::lock_guard lock(mutex_);
      if (!state_.retained || !state_.authorized || epoch != state_.epoch || generation <= original_generation_) return;
      if (ever_ready_ || state_.generation == generation) {
        withdraw("capture_changed");
        return;
      }
      state_.generation = generation;
      state_.ready = false;
      state_.first_frame = 0;
    }

    filter_state observe(std::uint64_t expected_epoch, process_state worker,
                         const display_snapshot &display, std::int64_t now) {
      std::lock_guard lock(mutex_);
      if (expected_epoch == state_.epoch) reconcile(worker, display, now);
      return view(now);
    }

    std::string renew(const binding &session, std::uint64_t epoch, process_state worker,
                      const display_snapshot &display, std::int64_t now) {
      std::lock_guard lock(mutex_);
      if (epoch != state_.epoch || !state_.retained || state_.session != session) return "stale";
      reconcile(worker, display, now);
      if (!state_.retained || !state_.authorized) return "expired";
      if (!state_.ready) return "not_ready";
      deadline_ = now + 15000;
      return "renewed";
    }

    std::string release(const binding &session, std::uint64_t epoch, process_state worker,
                        const display_snapshot &display, std::int64_t now) {
      std::lock_guard lock(mutex_);
      if (!state_.retained) return "released";
      if (epoch != state_.epoch || state_.session != session) return "stale";
      reconcile(worker, display, now);
      if (!state_.retained) return "released";
      withdraw("restoring");
      return "worker_alive"; // Unknown liveness is never proof of restoration.
    }

    filter_state snapshot(std::int64_t now) const {
      std::lock_guard lock(mutex_);
      return view(now);
    }

  private:
    static bool exclusive(const display_snapshot &display, const binding &session) {
      return display.streams.size() == 1 && display.streams[0].owner == session.owner && display.streams[0].id == session.stream;
    }
    bool same_geometry(const display_geometry &value) const {
      return value.id == geometry_.id && value.x == geometry_.x && value.y == geometry_.y &&
             value.width == geometry_.width && value.height == geometry_.height &&
             value.desktop_x == geometry_.desktop_x && value.desktop_y == geometry_.desktop_y &&
             value.desktop_width == geometry_.desktop_width && value.desktop_height == geometry_.desktop_height;
    }
    void withdraw(const char *reason) {
      state_.authorized = state_.ready = false;
      state_.first_frame = 0;
      state_.reason = reason;
    }
    void reconcile(process_state worker, const display_snapshot &display, std::int64_t now) {
      if (!state_.retained) return;
      if (worker == process_state::dead) {
        const auto next = state_.epoch + 1;
        state_ = {};
        state_.epoch = next;
        deadline_ = 0;
        ever_ready_ = false;
        return;
      }
      if (worker == process_state::unknown) { withdraw("identity_unavailable"); return; }
      if (!state_.authorized) return;
      if (now >= deadline_) { withdraw("expired"); return; }
      if (!exclusive(display, state_.session)) { withdraw("stream_changed"); return; }
      if (display.displays != catalog_ || display.phase == "switching" ||
          (display.capture && !same_geometry(*display.capture))) { withdraw("display_changed"); return; }
      if (ever_ready_ && (!display.capture || display.generation != state_.generation || display.phase != "active")) {
        withdraw("capture_changed"); return;
      }
      state_.ready = display.phase == "active" && display.capture && state_.generation > original_generation_ &&
                     display.generation == state_.generation && display.streams[0].generation == state_.generation && display.streams[0].first_frame > 0;
      state_.first_frame = state_.ready ? display.streams[0].first_frame : 0;
      ever_ready_ |= state_.ready;
    }
    filter_state view(std::int64_t now) const {
      auto result = state_;
      result.expires_ms = result.authorized ? std::clamp<std::int64_t>(deadline_ - now, 0, 15000) : 0;
      if (!result.expires_ms) result.authorized = result.ready = false;
      if (!result.ready) result.first_frame = 0;
      return result;
    }
    mutable std::mutex mutex_;
    filter_state state_;
    display_geometry geometry_;
    std::vector<std::string> catalog_;
    std::uint64_t original_generation_ = 0;
    std::int64_t deadline_ = 0;
    bool ever_ready_ = false;
  };

#ifdef __APPLE__
  filter_state native_state();
  std::string prepare_native(const binding &, const process_identity &);
  std::string renew_native(const binding &);
  std::string release_native(const binding &);
  void native_source_started(std::uint64_t epoch, std::uint64_t generation);
  bool native_source_current(std::uint64_t epoch);
  bool native_supported();
#endif
} // namespace cliprelay::privacy

#ifdef __OBJC__
  #import <ScreenCaptureKit/ScreenCaptureKit.h>
namespace cliprelay::privacy {
  NSArray<SCWindow *> *copy_native_windows(std::uint64_t &epoch) NS_RETURNS_RETAINED;
}
#endif
