// SPDX-License-Identifier: GPL-3.0-only
// Copied into the pinned host's tests/unit directory by prepare_sunshine.py.
#include "../tests_common.h"
#include "src/cliprelay_input.h"
#include "src/config.h"
#include "src/input.h"
#include "src/platform/virtualhid_input.h"
#include "src/utility.h"
extern "C" {
#include <moonlight-common-c/src/Input.h>
}
#include <cstring>

class ClipRelayInputTest : public ::testing::Test {
protected:
  decltype(config::input) saved;
  std::shared_ptr<input::input_t> input;
  std::shared_ptr<cliprelay::input_epoch> gate;
  std::vector<input::testing::keyboard_event_t> keys;
  int owner_key = 0;
  void SetUp() override {
    ASSERT_FALSE(task_pool.running());
    saved = config::input;
    config::input.keyboard = true;
    config::input.mouse = config::input.controller = false;
    config::input.key_repeat_delay = std::chrono::hours(1);
    auto platform = platf::input();
    ASSERT_TRUE(platform);
    platf::virtualhid::get_input_context(platform) = platf::virtualhid::input_context_t {lvh::BackendKind::fake};
    input::testing::set_platform_input(std::move(platform));
    input::testing::reset_keyboard_state();
    input::testing::set_keyboard_sink([this](const auto &key) { keys.push_back(key); });
    input = input::alloc(std::make_shared<safe::mail_raw_t>(), "cliprelay-epoch-fixture");
    gate = std::make_shared<cliprelay::input_epoch>();
    cliprelay::inputs.add(&owner_key, 1, std::string(64,'a'), gate);
  }
  void TearDown() override {
    cliprelay::inputs.remove(&owner_key);
    if (input) { input::reset(input); drain(); }
    input::testing::reset_keyboard_state();
    input::terminate_gamepads();
    input.reset();
    input::testing::set_keyboard_sink({});
    input::testing::set_platform_input({});
    config::input = saved;
  }
  static void drain() {
    for (int i=0; i<1000; ++i) {
      auto task = task_pool.pop();
      if (!task) return;
      (*task)->run();
    }
    FAIL() << "Input worker did not drain";
  }
  static std::vector<std::uint8_t> envelope(std::uint32_t epoch, unsigned op, std::vector<std::uint8_t> body={}) {
    std::vector<std::uint8_t> bytes {0,0,0,std::uint8_t(12+body.size()),0x4e,0x49,0x52,0x43,
      std::uint8_t(epoch>>24),std::uint8_t(epoch>>16),std::uint8_t(epoch>>8),std::uint8_t(epoch),std::uint8_t(op),0,0,0};
    bytes.insert(bytes.end(), body.begin(), body.end()); return bytes;
  }
  static std::vector<std::uint8_t> key(unsigned code, bool release=false) {
    NV_KEYBOARD_PACKET packet {};
    packet.header.size = util::endian::big(std::uint32_t(sizeof(packet)-4));
    packet.header.magic = util::endian::little(std::uint32_t(release?KEY_UP_EVENT_MAGIC:KEY_DOWN_EVENT_MAGIC));
    packet.keyCode = util::endian::little(std::int16_t(0x8000|code));
    std::vector<std::uint8_t> bytes(sizeof(packet)); std::memcpy(bytes.data(), &packet, sizeof(packet)); return bytes;
  }
  void send(std::vector<std::uint8_t> bytes) {input::passthrough_epoch(input, std::move(bytes), gate);}
};

TEST_F(ClipRelayInputTest, QueuedAndLatePacketsCannotCrossReleaseBoundary) {
  send(key('A')); drain(); ASSERT_EQ(keys.size(),1); ASSERT_FALSE(keys[0].release);
  send(key('B')); send(envelope(1,1));
  EXPECT_TRUE(gate->snapshot().pending); EXPECT_EQ(gate->snapshot().acknowledged,0);
  drain(); ASSERT_EQ(keys.size(),2); EXPECT_EQ(keys[1].key_code,'A'); EXPECT_TRUE(keys[1].release);
  EXPECT_EQ(gate->snapshot().acknowledged,1);
  send(key('D')); send(envelope(1,3,key('D'))); send(envelope(2,2)); send(envelope(2,3,key('D')));
  drain(); EXPECT_EQ(keys.size(),2); EXPECT_EQ(gate->snapshot().acknowledged,2);
  send(envelope(2,3,key('C'))); drain(); ASSERT_EQ(keys.size(),3); EXPECT_EQ(keys[2].key_code,'C');
  send(envelope(2,3,key('E'))); send(envelope(3,1)); drain();
  ASSERT_EQ(keys.size(),4); EXPECT_EQ(keys[3].key_code,'C'); EXPECT_TRUE(keys[3].release);
  send(envelope(4,2)); drain(); send(envelope(2,3,key('F'))); send(key('G')); drain(); EXPECT_EQ(keys.size(),4);
}

TEST_F(ClipRelayInputTest, RemovedContextCannotAcknowledgeOrDeliver) {
  send(key('A')); send(envelope(1,1));
  cliprelay::inputs.remove(&owner_key);
  auto old=gate; gate=std::make_shared<cliprelay::input_epoch>();
  cliprelay::inputs.add(&owner_key,2,std::string(64,'a'),gate);
  drain(); EXPECT_TRUE(keys.empty()); EXPECT_EQ(old->snapshot().acknowledged,0);
  send(key('B')); drain(); ASSERT_EQ(keys.size(),1); EXPECT_EQ(keys[0].key_code,'B');
}

TEST_F(ClipRelayInputTest, AnotherStreamPreventsSharedStateRelease) {
  send(key('A')); drain(); ASSERT_EQ(keys.size(),1);
  int second_key=0; auto second=std::make_shared<cliprelay::input_epoch>();
  cliprelay::inputs.add(&second_key,2,std::string(64,'b'),second);
  send(envelope(1,1)); drain();
  EXPECT_TRUE(gate->snapshot().failed); EXPECT_EQ(gate->snapshot().acknowledged,0); EXPECT_EQ(keys.size(),1);
  cliprelay::inputs.remove(&second_key);
}

TEST_F(ClipRelayInputTest, MalformedCommandsAndReplayCannotResumeInput) {
  auto invalid=envelope(1,1); invalid[13]=1; send(std::move(invalid));
  send(envelope(1,2)); send(envelope(7,1)); drain(); EXPECT_FALSE(gate->snapshot().enabled);
  send(envelope(1,1)); drain(); send(envelope(1,2)); send(envelope(1,1)); drain();
  EXPECT_EQ(gate->snapshot().acknowledged,1); EXPECT_TRUE(gate->snapshot().paused);
  auto short_key=key('A'); short_key.pop_back(); send(envelope(2,2)); drain();
  send(envelope(2,3,std::move(short_key))); drain(); EXPECT_TRUE(keys.empty());
}
