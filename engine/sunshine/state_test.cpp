// SPDX-License-Identifier: GPL-3.0-only
/** @file state_test.cpp @brief Portable state admission policy tests. */
#include "cliprelay_state.h"

#include <cassert>
#include <sstream>
#include <vector>

/** @brief Run policy cases without reading or modifying host filesystem state. */
int main() {
  using namespace cliprelay::macos;
  for (const auto *path : {"", "/", "relative", "//private/root", "/private//root", "/private/./root", "/private/../root", "/private/root/", "/private/ro\not", "/private/ro\tot"}) {
    assert(!state_path(path));
  }
  assert(!state_path(std::string("/") + std::string(4096, 'a')));
  assert(state_path("/private/ClipRelay Host #1"));
  assert(state_path("/Users/test/Library/Application Support/ClipRelay/host"));
  const char *host[] = {"engine"};
  const char *check[] = {"engine", "--cliprelay-state", "check"};
  int calls = 0;
  const auto secure = [&](std::string_view path) {
    ++calls;
    return path == "/private/owned";
  };
  std::ostringstream output;
  assert(state_command(1, host, nullptr, secure, output) == 2);
  assert(output.str() == "{\"protocol\":1,\"error\":\"state_directory_required\"}\n" && calls == 0);
  output.str("");
  assert(state_command(1, host, "relative/private", secure, output) == 2 && calls == 0);
  output.str("");
  assert(state_command(1, host, "/private/other-user", secure, output) == 2 && calls == 1);
  assert(output.str().find("other-user") == std::string::npos);
  output.str("");
  assert(!state_command(1, host, "/private/owned", secure, output) && output.str().empty());
  assert(state_command(3, check, "/private/owned", secure, output) == 0);
  assert(output.str() == "{\"protocol\":1,\"ready\":true}\n");
  output.str("");
  const int before = calls;
  for (const auto &args : std::vector<std::vector<const char *>> {
         {"engine", "--cliprelay-state"},
         {"engine", "--cliprelay-state", "initialize"},
         {"engine", "--cliprelay-state", "check", "extra"},
         {"engine", "--version", "--cliprelay-state", "check"},
         {"engine", "--cliprelay-state=check"}
       }) {
    assert(state_command(static_cast<int>(args.size()), args.data(), "/private/owned", secure, output) == 2);
    assert(calls == before);
    output.str("");
  }
  assert(state_command(3, check, "/private/owned", {}, output) == 2);
}
