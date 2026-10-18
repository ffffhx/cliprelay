// SPDX-License-Identifier: GPL-3.0-only
/** @file cliprelay_state.h @brief Private state admission before host initialization. */
#pragma once
#include <functional>
#include <optional>
#include <ostream>
#include <string_view>

namespace cliprelay::macos {
  /**
   * @brief Accept a bounded, unambiguous absolute POSIX directory spelling.
   * @param value State directory supplied by the owning application.
   * @return True for a non-root path without controls, empty or dot components.
   */
  inline bool state_path(std::string_view value) {
    if (value.size() < 2 || value.size() > 4096 || value.front() != '/') {
      return false;
    }
    for (const unsigned char c : value) {
      if (c < 32 || c == 127) {
        return false;
      }
    }
    std::size_t start = 1;
    for (;;) {
      const auto end = value.find('/', start);
      const auto component = value.substr(start, end == value.npos ? value.size() - start : end - start);
      if (component.empty() || component == "." || component == "..") {
        return false;
      }
      if (end == value.npos) {
        return true;
      }
      start = end + 1;
    }
  }

  /**
   * @brief Handle read-only state checks and gate ordinary host initialization.
   * @param argc Argument count including the executable name.
   * @param argv Process arguments, never reflected in a reply.
   * @param directory Explicit state root, absent when the owner did not provide it.
   * @param secure_directory Native canonical-path, ownership and mode validation.
   * @param output A bounded JSON response for a check or rejected startup.
   * @return No value for admitted startup, 0 for a check, or 2 for rejection.
   */
  inline std::optional<int> state_command(int argc, const char *const *argv, const char *directory, const std::function<bool(std::string_view)> &secure_directory, std::ostream &output) {
    constexpr std::string_view option = "--cliprelay-state";
    bool reserved = false;
    for (int index = 1; argv && index < argc; ++index) {
      reserved |= argv[index] && std::string_view(argv[index]).starts_with(option);
    }
    const auto error = [&](const char *code) {
      output << "{\"protocol\":1,\"error\":\"" << code << "\"}\n";
      return 2;
    };
    if (reserved && (argc != 3 || !argv[1] || !argv[2] || argv[1] != option || std::string_view(argv[2]) != "check")) {
      return error("invalid_command");
    }
    if (!directory) {
      return error("state_directory_required");
    }
    if (!state_path(directory) || !secure_directory || !secure_directory(directory)) {
      return error("invalid_state_directory");
    }
    if (reserved) {
      output << "{\"protocol\":1,\"ready\":true}\n";
      return 0;
    }
    return std::nullopt;
  }
}  // namespace cliprelay::macos
