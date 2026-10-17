// SPDX-License-Identifier: GPL-3.0-only
#include "cliprelay_privacy.h"
#include "cliprelay_owner.h"
#include <array>
#include <cerrno>
#include <condition_variable>
#include <libproc.h>
#include <signal.h>
#include <unistd.h>

namespace cliprelay::privacy {
  namespace {
    struct native_process {
      proc_bsdinfo info {};
      std::string path;
    };
    struct registration {
      process_identity identity;
      native_process parent, owner;
      std::string executable;
    };
    struct runtime_state {
      std::mutex mutex, operation;
      filter_control policy;
      registration registered;
      NSArray<SCWindow *> *__strong windows = nil;
      process_state liveness = process_state::unknown;
    } runtime;

    bool same_birth(const proc_bsdinfo &a, const proc_bsdinfo &b) {
      return a.pbi_pid == b.pbi_pid && a.pbi_start_tvsec == b.pbi_start_tvsec && a.pbi_start_tvusec == b.pbi_start_tvusec;
    }
    bool read_process(int pid, native_process &result) {
      if (pid <= 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &result.info, sizeof(result.info)) != sizeof(result.info)) return false;
      std::array<char, PROC_PIDPATHINFO_MAXSIZE> buffer {};
      if (proc_pidpath(pid, buffer.data(), static_cast<std::uint32_t>(buffer.size())) <= 0 || !buffer[0]) return false;
      const auto end = std::find(buffer.begin(), buffer.end(), '\0');
      if (end == buffer.end()) return false;
      result.path.assign(buffer.begin(), end);
      return result.info.pbi_pid == static_cast<std::uint32_t>(pid) && result.info.pbi_uid == geteuid();
    }
    bool register_worker(const process_identity &identity, registration &result) {
      if (!valid(identity) || !native_supported()) return false;
      native_process worker;
      if (!read_process(identity.pid, worker) || worker.info.pbi_start_tvsec != identity.birth_sec || worker.info.pbi_start_tvusec != identity.birth_usec ||
          !read_process(worker.info.pbi_ppid, result.parent) || !read_process(getppid(), result.owner)) return false;
      if (worker.path != result.parent.path || result.parent.info.pbi_ppid != result.owner.info.pbi_pid ||
          worker.info.pbi_pid == result.parent.info.pbi_pid || worker.info.pbi_pid == result.owner.info.pbi_pid) return false;
      result.identity = identity;
      result.executable = worker.path;
      return true;
    }
    process_state worker_state(const registration &entry) {
      proc_bsdinfo current {};
      errno = 0;
      if (proc_pidinfo(entry.identity.pid, PROC_PIDTBSDINFO, 0, &current, sizeof(current)) != sizeof(current)) {
        // Permission and transient native failures are not proof that a mask
        // disappeared. Only a positively absent/reused original process clears.
        if (kill(entry.identity.pid, 0) == -1 && errno == ESRCH) return process_state::dead;
        return process_state::unknown;
      }
      if (current.pbi_start_tvsec != entry.identity.birth_sec || current.pbi_start_tvusec != entry.identity.birth_usec) return process_state::dead;
      if (!native_supported() || current.pbi_uid != geteuid() || current.pbi_ppid != entry.parent.info.pbi_pid) return process_state::unknown;
      native_process worker, parent, owner;
      if (!read_process(entry.identity.pid, worker) || !read_process(entry.parent.info.pbi_pid, parent) || !read_process(getppid(), owner) ||
          worker.path != entry.executable || parent.path != entry.parent.path || owner.path != entry.owner.path ||
          !same_birth(parent.info, entry.parent.info) || !same_birth(owner.info, entry.owner.info) || parent.info.pbi_ppid != owner.info.pbi_pid) return process_state::unknown;
      return process_state::alive;
    }
    filter_state refresh_locked() {
      const auto now = display_control::monotonic_ms();
      auto state = runtime.policy.snapshot(now);
      if (state.retained) {
        runtime.liveness = worker_state(runtime.registered);
        state = runtime.policy.observe(state.epoch, runtime.liveness, displays.snapshot(), now);
        if (!state.retained) {
          runtime.windows = nil;
          runtime.registered = {};
        }
      }
      return state;
    }

    // The completion owns this heap object, including when the bounded wait
    // expires. It cannot refer to a returned stack or borrowed dispatch object.
    struct content_reply {
      std::mutex mutex;
      std::condition_variable ready;
      bool done = false;
      SCShareableContent *__strong content = nil;
    };
    NSArray<SCWindow *> *resolve_windows(const process_identity &identity) {
      std::uint32_t count = 0;
      if (CGGetActiveDisplayList(0, nullptr, &count) != kCGErrorSuccess || count != identity.windows.size() || count > 16) return nil;
      std::array<CGDirectDisplayID, 16> active {};
      if (CGGetActiveDisplayList(active.size(), active.data(), &count) != kCGErrorSuccess || count != identity.windows.size()) return nil;
      std::set<std::uint32_t> expected(active.begin(), active.begin() + count);
      // optionIncludingWindow modifies an above/below query; by itself it is
      // not a single-window lookup. Include offscreen/transparent windows and
      // then require exactly one native record for each registered identifier.
      NSArray *information = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
      if (!information) return nil;
      for (const auto &item : identity.windows) {
        if (!expected.erase(item.display)) return nil;
        NSDictionary *window = nil;
        for (NSDictionary *candidate in information) {
          if ([candidate[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] != item.id) continue;
          if (window) return nil;
          window = candidate;
        }
        if (!window || [window[(__bridge NSString *)kCGWindowOwnerPID] intValue] != identity.pid ||
            !window[(__bridge NSString *)kCGWindowAlpha] || [window[(__bridge NSString *)kCGWindowAlpha] doubleValue] != 0) return nil;
      }
      auto reply = std::make_shared<content_reply>();
      [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content, NSError *error) {
        std::lock_guard lock(reply->mutex);
        reply->content = error ? nil : content;
        reply->done = true;
        reply->ready.notify_all();
      }];
      std::unique_lock lock(reply->mutex);
      if (!reply->ready.wait_for(lock, std::chrono::seconds(2), [&] { return reply->done; }) || !reply->content) return nil;
      NSMutableArray<SCWindow *> *selected = [NSMutableArray array];
      for (const auto &item : identity.windows) {
        SCWindow *found = nil;
        for (SCWindow *window in reply->content.windows) {
          if (window.windowID == item.id && window.owningApplication.processID == identity.pid) {
            if (found) return nil;
            found = window;
          }
        }
        if (!found) return nil;
        [selected addObject:found];
      }
      return [selected copy];
    }
  }

  bool native_supported() {
    return macos::owner_admitted(STDIN_FILENO, getenv("CLIPRELAY_HOST_OWNER_PID")) && CGPreflightScreenCaptureAccess();
  }
  filter_state native_state() {
    @autoreleasepool {
      std::lock_guard lock(runtime.mutex);
      return refresh_locked();
    }
  }
  std::string prepare_native(const binding &session, const process_identity &worker) {
    @autoreleasepool {
      if (!valid(session) || !valid(worker)) return "invalid";
      std::unique_lock operation(runtime.operation, std::try_to_lock);
      if (!operation.owns_lock()) return "busy";
      {
        std::lock_guard lock(runtime.mutex);
        auto state = refresh_locked();
        if (state.retained) {
          return runtime.policy.prepare(session, worker, displays.snapshot(), display_control::monotonic_ms());
        }
      }
      registration registered;
      if (!register_worker(worker, registered)) return "worker_unavailable";
      NSArray<SCWindow *> *windows = resolve_windows(worker);
      if (!windows || worker_state(registered) != process_state::alive) return "windows_unavailable";
      std::lock_guard lock(runtime.mutex);
      const auto outcome = runtime.policy.prepare(session, worker, displays.snapshot(), display_control::monotonic_ms());
      if (outcome == "accepted") {
        runtime.registered = registered;
        runtime.windows = windows;
        runtime.liveness = process_state::alive;
      }
      return outcome;
    }
  }
  std::string renew_native(const binding &session) {
    @autoreleasepool {
      std::lock_guard lock(runtime.mutex);
      const auto state = refresh_locked();
      return runtime.policy.renew(session, state.epoch, runtime.liveness, displays.snapshot(), display_control::monotonic_ms());
    }
  }
  std::string release_native(const binding &session) {
    @autoreleasepool {
      std::lock_guard lock(runtime.mutex);
      const auto state = refresh_locked();
      return runtime.policy.release(session, state.epoch, runtime.liveness, displays.snapshot(), display_control::monotonic_ms());
    }
  }
  NSArray<SCWindow *> *copy_native_windows(std::uint64_t &epoch) {
    @autoreleasepool {
      std::lock_guard lock(runtime.mutex);
      const auto state = refresh_locked();
      epoch = state.epoch;
      if (!state.retained) return [[NSArray alloc] init];
      if (runtime.liveness != process_state::alive || !runtime.windows) return nil;
      return [runtime.windows copy];
    }
  }
  void native_source_started(std::uint64_t epoch, std::uint64_t generation) {
    @autoreleasepool {
      std::lock_guard lock(runtime.mutex);
      refresh_locked();
      runtime.policy.source_started(epoch, generation);
    }
  }
  bool native_source_current(std::uint64_t epoch) {
    @autoreleasepool {
      std::lock_guard lock(runtime.mutex);
      const auto state = refresh_locked();
      return epoch == state.epoch && (!state.retained || runtime.liveness == process_state::alive);
    }
  }
} // namespace cliprelay::privacy
