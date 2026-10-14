// SPDX-License-Identifier: GPL-3.0-only
#include "cliprelay_control.h"
#include <cassert>
#include <iostream>
#include <thread>

using cliprelay::display_control;
using cliprelay::display_geometry;
const std::string owner(64, 'a');
int client_a, client_b;
display_geometry left_screen {"left", -1920, -200, 1920, 1080, -1920, -200, 3840, 1280};
display_geometry right_screen {"right", 0, 0, 1920, 1080, -1920, -200, 3840, 1280};

void start(display_control &d) {
  d.catalog({"left", "right"});
  d.add_stream(&client_a, owner, 1280, 720);
  auto g = d.begin_capture(left_screen);
  d.bind(&client_a, g);
  d.real_frame(&client_a, g, 1);
  d.encoded(&client_a, 1);
  assert(d.snapshot().phase == "active");
}

int main() {
  {
    display_control d;
    d.catalog({"left", "right"});
    assert(d.request("right", d.snapshot().revision) == "not_streaming");
    d.encoded(nullptr, 1); // probe cannot create a stream
    assert(d.snapshot().phase == "idle");
  }
  {
    display_control d;
    start(d);
    auto original = d.snapshot();
    assert(original.capture->x == -1920 && original.capture->y == -200);
    assert(d.request("missing", original.revision) == "display_unavailable");
    assert(d.request("right", original.revision) == "accepted");
    assert(d.request("left", original.revision) == "stale");
    assert(d.request("left", d.snapshot().revision) == "busy");
    // Reordering after accepting a request must preserve the selected ID.
    assert(d.take_selection({"right", "left"}, 1) == 0);
    d.invalidate();
    auto g = d.begin_capture(right_screen);
    d.bind(&client_a, g);
    d.encoded(&client_a, 99); // dummy frame / no actual capture yet
    assert(d.snapshot().phase == "switching");
    d.real_frame(&client_a, g, 100);
    d.encoded(&client_a, 99); // buffered packet belonging to earlier input
    assert(d.snapshot().result == "pending");
    d.encoded(&client_a, 100);
    auto now = d.snapshot();
    assert(now.phase == "active" && now.result == "applied");
    assert(now.capture->id == "right" && now.streams[0].first_frame == 100);
    d.encoded(&client_a, 101);
    assert(d.snapshot().streams[0].first_frame == 100);
  }
  {
    display_control d;
    start(d);
    assert(d.request("right", d.snapshot().revision) == "accepted");
    assert(d.take_selection({"left"}, 0) == 0); // unplug between request and capture
    assert(d.snapshot().error == "display_unavailable");
    assert(!d.pending());
  }
  {
    display_control d;
    start(d);
    auto old = d.snapshot();
    d.catalog({"right", "left"});
    assert(d.request("right", old.revision) == "stale");
    d.invalidate();
    d.encoded(&client_a, 200);
    assert(!d.snapshot().capture && d.snapshot().phase != "active");
    auto g = d.begin_capture(right_screen);
    d.real_frame(&client_a, old.generation, 201);
    d.encoded(&client_a, 201);
    assert(d.snapshot().phase != "active"); // old encoder cannot reactivate state
    d.bind(&client_a, g);
    d.real_frame(&client_a, g, 202);
    d.encoded(&client_a, 202);
    assert(d.snapshot().phase == "active");
  }
  {
    display_control d;
    start(d);
    d.add_stream(&client_b, std::string(64, 'b'), 1920, 1200);
    auto g = d.snapshot().generation;
    d.bind(&client_b, g);
    d.real_frame(&client_b, g, 1);
    d.encoded(&client_b, 1);
    assert(d.snapshot().streams.size() == 2);
    d.remove_stream(&client_a);
    assert(d.snapshot().phase == "active" && d.snapshot().streams[0].owner != owner);
    assert(d.request("right", d.snapshot().revision) == "accepted");
    d.remove_stream(&client_b);
    assert(d.snapshot().phase == "idle" && d.snapshot().error == "disconnected");
    assert(!d.snapshot().capture && !d.pending());
  }
  {
    display_control d;
    start(d);
    assert(d.request("right", d.snapshot().revision) == "accepted");
    d.take_selection({"left", "right"}, 0);
    d.selection_failed();
    auto g = d.begin_capture(left_screen); // recover prior output after failure
    d.bind(&client_a, g);
    d.real_frame(&client_a, g, 20);
    d.encoded(&client_a, 20);
    assert(d.snapshot().phase == "active" && d.snapshot().result == "failed");
  }
  {
    display_control d;
    start(d);
    auto revision = d.snapshot().revision;
    std::string a, b;
    std::thread t1([&] { a = d.request("left", revision); });
    std::thread t2([&] { b = d.request("right", revision); });
    t1.join(); t2.join();
    assert((a == "accepted") != (b == "accepted"));
    assert((a == "stale") != (b == "stale"));
  }
  {
    display_control d;
    start(d);
    // A request arriving while capture is re-created is not acknowledged by
    // an unrelated output; the next capture iteration must consume it first.
    assert(d.request("right", d.snapshot().revision) == "accepted");
    auto g = d.begin_capture(left_screen);
    d.bind(&client_a, g);
    d.real_frame(&client_a, g, 2);
    d.encoded(&client_a, 2);
    assert(d.snapshot().result == "pending" && d.pending());
  }
  {
    cliprelay::bitrate_control b;
    b.add(&client_a, 1, owner, 5000, 3500, 20, 192, 0);
    assert(b.begin_encoder(&client_a) == 3500);
    auto s = *b.state(&client_a);
    assert(b.request(1, owner, s.revision, 2000) == "unsupported_encoder");
    b.support(&client_a, true);
    s = *b.state(&client_a);
    assert(b.request(2, owner, s.revision, 2000) == "not_streaming");
    assert(b.request(1, std::string(64, 'b'), s.revision, 2000) == "not_streaming");
    assert(b.request(1, owner, s.revision, 499) == "invalid_bitrate");
    assert(b.request(1, owner, s.revision, 150001) == "invalid_bitrate");
    assert(b.request(1, owner, s.revision, 2000) == "accepted");
    assert(b.request(1, owner, s.revision, 3000) == "stale");
    assert(b.request(1, owner, b.state(&client_a)->revision, 3000) == "busy");
    b.encoded(&client_a, 99); // unconsumed request is not an encoder update
    assert(b.state(&client_a)->result == "pending");
    auto update = *b.take(&client_a, 100);
    assert(update.target == 1268 && !b.take(&client_a, 101));
    b.encoded(&client_a, 99); // queued packet from before the parameter update
    assert(b.state(&client_a)->budget == 5000);
    b.encoded(&client_a, 100);
    s = *b.state(&client_a);
    assert(s.budget == 2000 && s.video == 1268 && s.result == "applied" && s.applied_frame == 100);
    b.fail(&client_a, update.request_id, "late_error");
    assert(b.begin_encoder(&client_a) == 1268); // persists after a display restart
    assert(b.state(&client_a)->result == "applied");
  }
  {
    cliprelay::bitrate_control b;
    b.add(&client_a, 10, owner, 6000, 4500, 20, 192, 5000);
    b.support(&client_a, true);
    auto s = *b.state(&client_a);
    assert(b.request(10, owner, s.revision, 150000) == "accepted");
    auto update = *b.take(&client_a, 50);
    assert(update.target == 5000); // host cap survives live updates
    b.fail(&client_a, update.request_id - 1, "stale_error");
    assert(b.state(&client_a)->result == "pending");
    b.fail(&client_a, update.request_id, "encoder_rejected");
    b.encoded(&client_a, 50);
    s = *b.state(&client_a);
    assert(s.result == "failed" && s.video == 4500 && s.budget == 6000 && !s.applied_frame);
    assert(b.request(10, owner, s.revision, 8000) == "accepted");
    b.take(&client_a, 51);
    assert(b.begin_encoder(&client_a) == 4500);
    assert(b.state(&client_a)->error == "encoder_restarted");
    b.encoded(&client_a, 51);
    assert(b.state(&client_a)->video == 4500);
    b.remove(&client_a);
    b.add(&client_a, 11, owner, 5000, 3500, 20, 192, 0); // same pointer, new stream
    b.support(&client_a, true);
    assert(b.request(10, owner, b.state(&client_a)->revision, 8000) == "not_streaming");
  }
  {
    cliprelay::bitrate_control b;
    b.add(&client_a, 1, owner, 5000, 3500, 20, 192, 0);
    b.add(&client_b, 2, std::string(64, 'b'), 8000, 5500, 20, 512, 0);
    b.support(&client_a, true); b.support(&client_b, true);
    const auto before = *b.state(&client_b);
    const auto revision = b.state(&client_a)->revision;
    std::string a, c;
    std::thread t1([&] { a = b.request(1, owner, revision, 2000); });
    std::thread t2([&] { c = b.request(1, owner, revision, 6000); });
    t1.join(); t2.join();
    assert((a == "accepted") != (c == "accepted"));
    assert((a == "stale") != (c == "stale"));
    b.take(&client_a, 20); b.encoded(&client_a, 20);
    const auto after = *b.state(&client_b);
    assert(after.video == before.video && after.revision == before.revision && after.result.empty());
    b.remove(&client_a);
    assert(b.snapshot().size() == 1 && b.state(&client_b));
  }
  {
    assert(cliprelay::video_bitrate(500, 20, 512, 0) == 288);
    assert(cliprelay::video_bitrate(10000, 81, 192, 0) == 9308);
    assert(cliprelay::video_bitrate(10000, 20, 512, 4000) == 4000);
  }
  std::cout << "8 display and 4 live bitrate control scenarios passed\n";
}
