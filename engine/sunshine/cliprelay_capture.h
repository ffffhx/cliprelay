// SPDX-License-Identifier: GPL-3.0-only
/**
 * @file cliprelay_capture.h
 * @brief Capture-thread polling with bounded frame waits and explicit recovery.
 */
#pragma once
#include <chrono>

namespace cliprelay {
  /** @brief Result from a real captured frame's processing callback. */
  enum class frame_result {
    keep_going,
    stopped,
    error
  };
  /** @brief Reason for leaving the capture loop. */
  enum class capture_result {
    stopped,
    reinit,
    error
  };

  /**
   * @brief Keep stream controls responsive while an asynchronous source stalls.
   * @param wait_frame Return an owned frame, or an empty value within the wait budget.
   * @param process Process a real frame on the calling capture thread.
   * @param idle Check stream controls without claiming a newly captured image.
   * @param stable Check current display geometry and capture permission.
   * @param now Monotonic clock, injectable for deterministic deadline tests.
   * @return Stop, reinitialization, or processing failure.
   *
   * The latest frame returned by wait_frame stays owned until processing ends.
   * Empty polls cannot refresh the three-second real-frame deadline. No user
   * callback is moved onto a system capture callback queue.
   */
  template<class Wait, class Process, class Idle, class Stable, class Clock>
  capture_result capture_loop(Wait wait_frame, Process process, Idle idle, Stable stable, Clock now) {
    using namespace std::chrono_literals;
    auto last_frame = now();
    auto check_geometry = last_frame;
    while (true) {
      const auto time = now();
      if (time >= check_geometry) {
        if (!stable()) {
          return capture_result::reinit;
        }
        check_geometry = time + 100ms;
      }
      if (time - last_frame >= 3s) {
        return capture_result::reinit;
      }
      auto frame = wait_frame(100ms);
      if (!frame) {
        if (!idle()) {
          return capture_result::stopped;
        }
        continue;
      }
      switch (process(frame)) {
        case frame_result::stopped:
          return capture_result::stopped;
        case frame_result::error:
          return capture_result::error;
        case frame_result::keep_going:
          last_frame = now();
          break;
      }
    }
  }
}  // namespace cliprelay
