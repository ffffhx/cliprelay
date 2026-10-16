// SPDX-License-Identifier: GPL-3.0-only
/** @file cliprelay_owner.h @brief Parent and private-pipe ownership for the Mac host. */
#pragma once
#include <charconv>
#include <limits>
#include <string_view>

namespace cliprelay::macos {
  /**
   * @brief Match a canonical decimal owner PID to the actual direct parent.
   * @param value Owner PID supplied by the application, or null when absent.
   * @param parent Current direct parent PID.
   * @return True only for a non-init parent and an exact decimal match.
   */
  inline bool owner_pid(const char *value, int parent) {
    if (!value || parent <= 1) {
      return false;
    }
    const std::string_view text {value};
    if (text.empty() || text.size() > 10 || text.front() == '0') {
      return false;
    }
    int parsed = 0;
    const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
    return result.ec == std::errc {} && result.ptr == text.data() + text.size() && parsed == parent;
  }
}  // namespace cliprelay::macos

#ifdef __APPLE__
  #include <atomic>
  #include <cerrno>
  #include <chrono>
  #include <cstdlib>
  #include <fcntl.h>
  #include <functional>
  #include <poll.h>
  #include <sys/socket.h>
  #include <sys/stat.h>
  #include <thread>
  #include <unistd.h>
  #include <utility>

namespace cliprelay::macos {
  /**
   * @brief Accept a local pipe or connected Unix stream socket owned by this user.
   * @param descriptor Borrowed input descriptor; never closed by this function.
   * @return True for a private pipe transport, never a file, terminal or TCP socket.
   */
  inline bool owner_pipe(int descriptor) {
    struct stat info {};
    if (fstat(descriptor, &info) != 0 || info.st_uid != geteuid()) {
      return false;
    }
    const auto flags = fcntl(descriptor, F_GETFL);
    if (flags < 0 || (flags & O_ACCMODE) == O_WRONLY) {
      return false;
    }
    if (S_ISFIFO(info.st_mode)) {
      return true;
    }
    if (!S_ISSOCK(info.st_mode)) {
      return false;
    }
    int type = 0;
    socklen_t length = sizeof(type);
    if (getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &length) != 0 || type != SOCK_STREAM) {
      return false;
    }
    sockaddr_storage local {}, peer {};
    socklen_t local_length = sizeof(local), peer_length = sizeof(peer);
    return getsockname(descriptor, reinterpret_cast<sockaddr *>(&local), &local_length) == 0 &&
           getpeername(descriptor, reinterpret_cast<sockaddr *>(&peer), &peer_length) == 0 &&
           local.ss_family == AF_UNIX && peer.ss_family == AF_UNIX;
  }

  /**
   * @brief Check that the owner's pipe is open and carries no unexpected input.
   * @param descriptor Borrowed descriptor.
   * @param timeout Maximum poll duration in milliseconds.
   * @return True on an idle, connected transport; EOF, input and errors reject it.
   */
  inline bool owner_idle(int descriptor, int timeout = 0) {
    pollfd entry {descriptor, POLLIN, 0};
    const auto result = poll(&entry, 1, timeout);
    return result == 0 || (result < 0 && errno == EINTR);
  }

  /**
   * @brief Admit only a live direct parent with an idle local ownership pipe.
   * @param descriptor Borrowed ownership descriptor.
   * @param value Expected parent PID supplied by the application.
   * @param parent Direct parent captured before admission, reused by the monitor.
   * @return True when all ownership checks pass together.
   */
  inline bool owner_admitted(int descriptor, const char *value, int parent = getppid()) {
    return owner_pid(value, parent) && getppid() == parent && owner_pipe(descriptor) && owner_idle(descriptor);
  }

  /** @brief Joinable lifetime monitor; EOF or parent death requests bounded shutdown. */
  class owner_monitor {
  public:
    /**
     * @brief Monitor an already admitted, borrowed ownership descriptor.
     * @param descriptor Local input pipe kept open only by the owner.
     * @param parent Admitted direct parent PID, checked again throughout startup.
     * @param lost Nonblocking callback requesting normal engine cleanup.
     * @param force Callback for cleanup that exceeds its deadline.
     * @param grace Maximum graceful cleanup duration; ten seconds in production.
     */
    owner_monitor(int descriptor, int parent, std::function<void()> lost, std::function<void()> force, std::chrono::milliseconds grace = std::chrono::seconds(10)):
        descriptor_(descriptor),
        parent_(parent),
        lost_(std::move(lost)),
        force_(std::move(force)),
        grace_(grace),
        worker_([this] {
          run();
        }) {}

    /** @brief Stop and join the monitor without closing the borrowed descriptor. */
    ~owner_monitor() {
      stopping_.store(true);
      if (worker_.joinable()) {
        worker_.join();
      }
    }

    /** @brief A live monitor cannot be copied. */
    owner_monitor(const owner_monitor &) = delete;
    /** @brief A live monitor cannot be replaced by assignment. */
    owner_monitor &operator=(const owner_monitor &) = delete;

    /** @brief Return whether the monitor still observes its original owner. */
    bool connected() const {
      return connected_.load() && getppid() == parent_;
    }

  private:
    /** @brief Detect ownership loss, request cleanup, and enforce the deadline. */
    void run() noexcept {
      try {
        while (!stopping_.load() && getppid() == parent_ && owner_idle(descriptor_, 100)) {}
        if (stopping_.load()) {
          return;
        }
        connected_.store(false);
        lost_();
        const auto deadline = std::chrono::steady_clock::now() + grace_;
        while (!stopping_.load() && std::chrono::steady_clock::now() < deadline) {
          std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        if (!stopping_.load()) {
          force_();
        }
      } catch (...) {
        std::_Exit(70);
      }
    }

    int descriptor_;  ///< Borrowed local input descriptor.
    int parent_;  ///< Direct parent captured at admission.
    std::function<void()> lost_;  ///< Normal cleanup request.
    std::function<void()> force_;  ///< Hard deadline action.
    std::chrono::milliseconds grace_;  ///< Graceful cleanup budget.
    std::atomic<bool> stopping_ {false};  ///< Monitor teardown request.
    std::atomic<bool> connected_ {true};  ///< Last observed ownership state.
    std::thread worker_;  ///< Joined before members are destroyed.
  };
}  // namespace cliprelay::macos
#endif
