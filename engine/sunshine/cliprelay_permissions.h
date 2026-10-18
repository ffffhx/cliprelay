// SPDX-License-Identifier: GPL-3.0-only
/**
 * @file cliprelay_permissions.h
 * @brief Explicit, bounded permission-command replies before host initialization.
 */
#pragma once
#include <functional>
#include <optional>
#include <ostream>
#include <string_view>

namespace cliprelay::macos {
  /** @brief Native permission boundaries; query callbacks never request access. */
  struct permission_api {
    std::function<bool()> screen;  ///< Current screen-recording preflight.
    std::function<bool()> input;  ///< Current event-posting preflight.
    std::function<bool()> request_screen;  ///< Explicit screen-recording request.
    std::function<bool()> request_input;  ///< Explicit event-posting request.
  };

  /**
   * @brief Handle reserved permission commands without initializing a host.
   * @param argc Number of arguments, including the executable name.
   * @param argv Process arguments; no user-supplied value is reflected in replies.
   * @param api Native queries and requests, injectable without opening OS prompts.
   * @param output One JSON reply for handled commands, empty for normal startup.
   * @return No value for normal startup; 0 for a valid request/query, 2 for bad
   *         arguments, or 3 when required native functions are unavailable.
   *
   * Only the exact request-screen or request-input action may call a requester.
   * Denial is a successful command with false permission state, never a grant.
   * A reserved token in the wrong position fails before config/log initialization.
   */
  inline std::optional<int> permission_command(int argc, const char *const *argv, const permission_api &api, std::ostream &output) {
    constexpr std::string_view option = "--cliprelay-permissions";
    bool reserved = false;
    for (int index = 1; argv && index < argc; ++index) {
      reserved |= argv[index] && std::string_view(argv[index]).starts_with(option);
    }
    if (!reserved) {
      return std::nullopt;
    }
    const auto invalid = [&] {
      output << "{\"protocol\":1,\"error\":\"invalid_command\"}\n";
      return 2;
    };
    if (argc != 3 || !argv[1] || !argv[2] || argv[1] != option) {
      return invalid();
    }
    const std::string_view action = argv[2];
    if (action != "status" && action != "request-screen" && action != "request-input") {
      return invalid();
    }
    if (!api.screen || !api.input || (action == "request-screen" && !api.request_screen) || (action == "request-input" && !api.request_input)) {
      output << "{\"protocol\":1,\"error\":\"unavailable\"}\n";
      return 3;
    }
    const char *requested = "none";
    if (action == "request-screen") {
      api.request_screen();
      requested = "screenRecording";
    } else if (action == "request-input") {
      api.request_input();
      requested = "inputControl";
    }
    const bool screen = api.screen();
    const bool input = api.input();
    output << "{\"protocol\":1,\"screenRecording\":" << (screen ? "true" : "false")
           << ",\"inputControl\":" << (input ? "true" : "false")
           << ",\"requested\":\"" << requested << "\"}\n";
    return 0;
  }
}  // namespace cliprelay::macos
