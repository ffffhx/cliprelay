// SPDX-License-Identifier: GPL-3.0-only
#include "cliprelay_privacy.h"
#include <cassert>
#include <barrier>
#include <iostream>
#include <thread>

using namespace cliprelay;
using namespace cliprelay::privacy;
namespace {
  struct fixture {
    display_control display;
    filter_control filter;
    int client, other;
    binding session {std::string(64, 'a'), std::string(32, 'b'), 1};
    process_identity worker {123, 456, 7, {{10, 1}, {20, 2}}};
    display_geometry geometry {"1", 0, 0, 1920, 1080, 0, 0, 3840, 1080};
    std::uint64_t epoch = 0, generation = 0;
    fixture() {
      display.catalog({"1", "2"}); display.add_stream(&client, session.owner, 1280, 720);
      generation = display.begin_capture(geometry); display.bind(&client, generation);
      display.real_frame(&client, generation, 1); display.encoded(&client, 1);
      assert(filter.prepare(session, worker, display.snapshot(), 0) == "accepted");
      epoch = filter.snapshot(0).epoch;
    }
    filter_state state(std::int64_t now = 1000, process_state alive = process_state::alive) {
      return filter.observe(epoch, alive, display.snapshot(), now);
    }
    void rebuild() {
      display.invalidate(); generation = display.begin_capture(geometry);
      display.bind(&client, generation); filter.source_started(epoch, generation);
    }
    void ready() {
      rebuild(); display.real_frame(&client, generation, 100); display.encoded(&client, 100);
      assert(state().ready);
    }
  };
  std::vector<std::string> passed;
  template<class F> void run(const char *name, F action) { action(); passed.emplace_back(name); }
}

int main() {
  run("filtered-source-and-real-encoded-generation-required", [] {
    fixture f;
    assert(!f.state().ready);
    f.filter.source_started(f.epoch, f.generation); // The old active display is insufficient.
    assert(!f.state().ready);
    f.rebuild();
    f.display.encoded(&f.client, 90); assert(!f.state().ready); // Dummy packet.
    f.display.real_frame(&f.client, f.generation - 1, 100); f.display.encoded(&f.client, 100);
    assert(!f.state().ready); // Stale captured image.
    f.display.real_frame(&f.client, f.generation, 101); f.display.encoded(&f.client, 100);
    assert(!f.state().ready); // Delayed old encoded packet.
    f.display.encoded(&f.client, 101);
    const auto state = f.state();
    assert(state.ready && state.generation == f.generation && state.first_frame == 101);
  });
  run("expiry-and-replays-retain-filter-without-renewal", [] {
    fixture f; f.ready();
    assert(f.filter.prepare(f.session, f.worker, f.display.snapshot(), 14999) == "accepted");
    assert(f.state(14999).expires_ms == 1);
    auto expired = f.state(15000);
    assert(expired.retained && !expired.authorized && !expired.ready && expired.epoch == f.epoch);
    assert(f.filter.renew(f.session, f.epoch, process_state::alive, f.display.snapshot(), 15000) == "expired");
    assert(f.filter.prepare(f.session, f.worker, f.display.snapshot(), 15000) == "expired");
    assert(!f.state(15001).ready);
    fixture renewed; renewed.ready();
    assert(renewed.filter.renew(renewed.session, renewed.epoch, process_state::alive, renewed.display.snapshot(), 1000) == "renewed");
    assert(renewed.state(15999).expires_ms == 1 && !renewed.state(16000).authorized);
  });
  run("foreign-and-malformed-native-bindings-are-rejected", [] {
    fixture f; f.ready();
    auto foreign = f.session; foreign.lease[0] = 'c';
    assert(f.filter.prepare(foreign, f.worker, f.display.snapshot(), 1000) == "busy");
    assert(f.filter.release(foreign, f.epoch, process_state::dead, f.display.snapshot(), 1000) == "stale");
    assert(f.state().ready);
    auto invalid = f.worker; invalid.windows.push_back(invalid.windows[0]); assert(!valid(invalid));
    invalid = f.worker; invalid.windows[1].display = invalid.windows[0].display; assert(!valid(invalid));
    invalid = f.worker; invalid.pid = 1; assert(!valid(invalid));
    invalid = f.worker; invalid.birth_usec = 1000000; assert(!valid(invalid));
    foreign = f.session; foreign.owner[0] = 'A'; assert(!valid(foreign));
    foreign = f.session; foreign.stream = 1ULL << 53; assert(!valid(foreign));
    filter_control idle; auto state = f.display.snapshot(); state.streams.clear();
    assert(idle.prepare(f.session, f.worker, state, 0) == "not_streaming");
  });
  run("unknown-worker-does-not-prove-restoration", [] {
    fixture f; f.ready();
    const auto unknown = f.state(1001, process_state::unknown);
    assert(unknown.retained && !unknown.authorized && !unknown.ready);
    assert(!f.state(1002).authorized); // No automatic reactivation after an identity failure.
    const auto dead = f.state(1003, process_state::dead);
    assert(!dead.retained && dead.epoch > f.epoch);
  });
  run("source-and-observer-replays-cannot-claim-new-readiness", [] {
    fixture duplicate; duplicate.ready();
    duplicate.filter.source_started(duplicate.epoch, duplicate.generation);
    assert(!duplicate.state().authorized);
    fixture changed; changed.ready(); changed.rebuild();
    assert(!changed.state().authorized);
    fixture f; f.ready(); const auto old_epoch = f.epoch;
    f.state(1001, process_state::dead);
    auto next = f.session; next.lease[0] = 'c';
    assert(f.filter.prepare(next, f.worker, f.display.snapshot(), 1002) == "accepted");
    f.epoch = f.filter.snapshot(1002).epoch;
    f.filter.source_started(old_epoch, f.generation + 1);
    const auto stale = f.filter.observe(old_epoch, process_state::dead, f.display.snapshot(), 1003);
    assert(stale.retained && stale.authorized && !stale.ready && stale.epoch == f.epoch);
  });
  run("stream-display-and-capture-changes-withdraw-authorization", [] {
    for (int kind = 0; kind < 7; ++kind) {
      fixture f; f.ready(); auto state = f.display.snapshot();
      switch (kind) {
        case 0: state.streams.push_back(state.streams[0]); break;
        case 1: state.streams[0].owner[0] = 'c'; break;
        case 2: ++state.capture->desktop_width; break;
        case 3: state.capture.reset(); break;
        case 4: state.displays.push_back("3"); break;
        case 5: state.phase = "switching"; break;
        case 6: ++state.generation; break;
      }
      const auto changed = f.filter.observe(f.epoch, process_state::alive, state, 1001);
      assert(changed.retained && !changed.authorized && !changed.ready);
    }
  });
  run("release-requires-confirmed-original-worker-death", [] {
    fixture f; f.ready();
    assert(f.filter.release(f.session, f.epoch, process_state::alive, f.display.snapshot(), 1001) == "worker_alive");
    assert(f.state(1002).retained && !f.state(1002).authorized);
    assert(f.filter.release(f.session, f.epoch, process_state::unknown, f.display.snapshot(), 1003) == "worker_alive");
    assert(f.filter.release(f.session, f.epoch, process_state::dead, f.display.snapshot(), 1004) == "released");
    const auto restored = f.filter.snapshot(1005);
    assert(!restored.retained && restored.epoch > f.epoch && restored.session.lease.empty());
  });
  run("concurrent-late-renewal-cannot-revive-expired-filter", [] {
    fixture f; f.ready(); std::barrier start(3);
    std::thread renew([&] { start.arrive_and_wait(); for (int i = 0; i < 100; ++i)
      assert(f.filter.renew(f.session, f.epoch, process_state::alive, f.display.snapshot(), 15000) == "expired"); });
    std::thread observe([&] { start.arrive_and_wait(); for (int i = 0; i < 100; ++i) assert(!f.state(15000).ready); });
    start.arrive_and_wait(); renew.join(); observe.join();
    assert(f.state(15001).retained && !f.state(15001).authorized);
  });
  std::cout << "{\"passed\":true,\"cases\":[";
  for (std::size_t i = 0; i < passed.size(); ++i) std::cout << (i ? "," : "") << '"' << passed[i] << '"';
  std::cout << "]}\n";
}
