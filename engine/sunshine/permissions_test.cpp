// SPDX-License-Identifier: GPL-3.0-only
/**
 * @file permissions_test.cpp
 * @brief Test production permission-command policy without any OS access.
 */
#include "cliprelay_permissions.h"

#include <cassert>
#include <initializer_list>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

/** @brief Exercise query/request separation and early rejection of malformed CLI. */
int main() {
  bool screen = false, input = false, grant = false;
  std::vector<std::string> calls;
  cliprelay::macos::permission_api api {
    [&] {
      calls.emplace_back("screen");
      return screen;
    },
    [&] {
      calls.emplace_back("input");
      return input;
    },
    [&] {
      calls.emplace_back("request-screen");
      screen = grant;
      return grant;
    },
    [&] {
      calls.emplace_back("request-input");
      input = grant;
      return grant;
    }
  };
  const auto run = [&](std::initializer_list<const char *> args) {
    calls.clear();
    std::ostringstream reply;
    const auto code = cliprelay::macos::permission_command(static_cast<int>(args.size()), args.begin(), api, reply);
    return std::pair {code, reply.str()};
  };
  for (auto args : {std::initializer_list<const char *> {"engine"}, {"engine", "--version"}, {"engine", "config.conf", "--creds", "user", "password"}}) {
    const auto [code, reply] = run(args);
    assert(!code && reply.empty() && calls.empty());
  }
  const auto [denied_code, denied_reply] = run({"engine", "--cliprelay-permissions", "status"});
  assert(denied_code == 0);
  assert(denied_reply == "{\"protocol\":1,\"screenRecording\":false,\"inputControl\":false,\"requested\":\"none\"}\n");
  assert((calls == std::vector<std::string> {"screen", "input"}));
  screen = true;
  input = true;
  const auto [allowed_code, allowed_reply] = run({"engine", "--cliprelay-permissions", "status"});
  assert(allowed_code == 0 && allowed_reply.find("\"screenRecording\":true,\"inputControl\":true") != std::string::npos);
  screen = false;
  const auto [revoked_code, revoked_reply] = run({"engine", "--cliprelay-permissions", "status"});
  assert(revoked_code == 0 && revoked_reply.find("\"screenRecording\":false,\"inputControl\":true") != std::string::npos);
  assert((calls == std::vector<std::string> {"screen", "input"}));
  const auto [request_denied_code, request_denied_reply] = run({"engine", "--cliprelay-permissions", "request-screen"});
  assert(request_denied_code == 0 && request_denied_reply.find("\"screenRecording\":false") != std::string::npos);
  assert(request_denied_reply.find("\"requested\":\"screenRecording\"") != std::string::npos);
  assert((calls == std::vector<std::string> {"request-screen", "screen", "input"}));
  grant = true;
  input = false;
  const auto [screen_code, screen_reply] = run({"engine", "--cliprelay-permissions", "request-screen"});
  assert(screen_code == 0 && screen_reply.find("\"screenRecording\":true,\"inputControl\":false") != std::string::npos);
  assert((calls == std::vector<std::string> {"request-screen", "screen", "input"}));
  const auto [input_code, input_reply] = run({"engine", "--cliprelay-permissions", "request-input"});
  assert(input_code == 0 && input_reply.find("\"inputControl\":true,\"requested\":\"inputControl\"") != std::string::npos);
  assert((calls == std::vector<std::string> {"request-input", "screen", "input"}));
  for (auto args : {std::initializer_list<const char *> {"engine", "--cliprelay-permissions"}, {"engine", "--cliprelay-permissions", "status", "extra"}, {"engine", "config.conf", "--cliprelay-permissions", "request-screen"}, {"engine", "--cliprelay-permissions=request-input", "status"}, {"engine", "--cliprelay-permissions", "request-all"}, {"engine", "--cliprelay-permissions", nullptr}, {"engine", "--cliprelay-permissions", "request-input", "extra"}}) {
    const auto [code, reply] = run(args);
    assert(code == 2 && reply == "{\"protocol\":1,\"error\":\"invalid_command\"}\n" && calls.empty());
  }
  api.request_screen = {};
  const auto [missing_code, missing_reply] = run({"engine", "--cliprelay-permissions", "request-screen"});
  assert(missing_code == 3 && missing_reply == "{\"protocol\":1,\"error\":\"unavailable\"}\n" && calls.empty());
  const auto [query_code, query_reply] = run({"engine", "--cliprelay-permissions", "status"});
  assert(query_code == 0 && !query_reply.empty() && calls.size() == 2);
  api.input = {};
  const auto [missing_query_code, missing_query_reply] = run({"engine", "--cliprelay-permissions", "request-input"});
  assert(missing_query_code == 3 && missing_query_reply == "{\"protocol\":1,\"error\":\"unavailable\"}\n" && calls.empty());
  std::cout << "Permission command policy passed: unrelated startup, query isolation, fresh state, denial, screen request, input request, malformed arguments, unavailable requester\n";
}
