// SPDX-License-Identifier: GPL-3.0-only
/** @file owner_test.cpp @brief Portable direct-parent admission policy checks. */
#include "cliprelay_owner.h"

#include <cassert>
#include <initializer_list>

/** @brief Reject ambiguous, missing, overflowing or unrelated process identities. */
int main() {
  using cliprelay::macos::owner_pid;
  assert(owner_pid("2345", 2345));
  assert(owner_pid("2147483647", 2147483647));
  assert(!owner_pid(nullptr, 2345));
  for (const auto *value : {"", "1", "0", "-2345", "+2345", "02345", "2345 ", " 2345", "2345\n", "2345x", "2147483648", "99999999999", "2346"}) {
    assert(!owner_pid(value, 2345));
  }
  assert(!owner_pid("1", 1));
  assert(!owner_pid("2", -1));
}
