// SPDX-License-Identifier: GPL-3.0-only
// Process ancestry/lifetime checks only: no audio activation or endpoint writes.
#include "cliprelay_audio.h"
#include <cstdio>
#include <string>
#include <fstream>

int main(int argc, char **argv) {
  if (argc == 2 && std::string(argv[1]) == "--self") {
    cliprelay::audio_exclusion_root implicit, explicit_self, invalid;
    if (implicit.open(0) != S_OK || implicit.pid() != GetCurrentProcessId() || !implicit.alive() ||
        explicit_self.open(GetCurrentProcessId()) != S_OK || !explicit_self.alive() ||
        SUCCEEDED(invalid.open(0xffffffff)) || invalid.alive() || implicit.open(0) != E_UNEXPECTED) return 1;
    std::puts("PASS self, default, invalid PID and duplicate initialization");
    return 0;
  }
  if (argc < 3) return 2;
  char *end = nullptr;
  unsigned long value = std::strtoul(argv[2], &end, 10);
  if (!value || !end || *end) return 2;
  DWORD pid = static_cast<DWORD>(value);
  if (argc == 3 && std::string(argv[1]) == "--check") {
    cliprelay::audio_exclusion_root root;
    return root.open(pid) == S_OK && root.alive() ? 0 : 3;
  }
  if (argc == 4 && (std::string(argv[1]) == "--watch" || std::string(argv[1]) == "--late")) {
    bool late = std::string(argv[1]) == "--late";
    cliprelay::audio_exclusion_root root;
    if (!late && root.open(pid) != S_OK) return 4;
    std::puts("ready"); std::fflush(stdout);
    // The parent closes this pipe by exiting. Bound subsequent polling even
    // when a test assertion fails; fixtures must not outlive their test run.
    std::getchar();
    bool passed = false;
    auto until = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    do {
      if (late) {
        cliprelay::process_audio_detail::process_handle process(OpenProcess(SYNCHRONIZE, FALSE, pid));
        if (!process.value || WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) {
          passed = FAILED(root.open(pid)); break;
        }
      } else if (!root.alive()) { passed = true; break; }
      Sleep(10);
    } while (std::chrono::steady_clock::now() < until);
    std::ofstream result(argv[3], std::ios::binary);
    result << (passed ? "passed" : "failed");
    return passed ? 0 : 5;
  }
  return 2;
}
