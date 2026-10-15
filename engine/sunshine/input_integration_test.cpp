// SPDX-License-Identifier: GPL-3.0-only
// Copied into the pinned host's tests/unit directory by prepare_sunshine.py.
#include "../tests_common.h"
#include "src/cliprelay_input.h"
#include "src/config.h"
#include "src/globals.h"
#include "src/input.h"
#include "src/platform/virtualhid_input.h"
#include "src/utility.h"
extern "C" {
#include <moonlight-common-c/src/Input.h>
}
#include <cstring>
#include <thread>

class ClipRelayInputTest : public ::testing::Test {
protected:
  decltype(config::input) saved;
  std::shared_ptr<input::input_t> input;
  std::shared_ptr<cliprelay::input_epoch> gate;
  std::vector<input::testing::keyboard_event_t> keys;
  platf::virtualhid::input_context_t *platform_context = nullptr;
  safe::mail_t mailbox;
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
    platform_context = &platf::virtualhid::get_input_context(platform);
    ASSERT_TRUE(platform_context->mouse);
    input::testing::set_platform_input(std::move(platform));
    input::testing::reset_keyboard_state();
    input::testing::set_keyboard_sink([this](const auto &key) { keys.push_back(key); });
    mailbox = std::make_shared<safe::mail_raw_t>();
    input = input::alloc(mailbox, "cliprelay-epoch-fixture");
    input::touch_port_t port {};
    port.width = port.logical_width = port.env_width = 1280;
    port.height = port.logical_height = port.env_height = 720;
    port.scalar_inv = port.scalar_tpcoords = 1.0F;
    mailbox->event<input::touch_port_t>(mail::touch_port)->raise(port);
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
  static void run_one() {
    // Immediate tasks precede timers in the production task pool. Running only
    // the UP ingress task lets the test enqueue pause before its delayed release,
    // without wall-clock sleeps or races with a background worker.
    auto task = task_pool.pop();
    ASSERT_TRUE(task);
    (*task)->run();
  }
  template<class Packet>
  static std::vector<std::uint8_t> packet_bytes(Packet packet, std::uint32_t magic) {
    packet.header.size = util::endian::big(std::uint32_t(sizeof(packet)-4));
    packet.header.magic = util::endian::little(magic);
    std::vector<std::uint8_t> bytes(sizeof(packet));
    std::memcpy(bytes.data(), &packet, sizeof(packet));
    return bytes;
  }
  static std::vector<std::uint8_t> mouse(unsigned button, bool release=false) {
    NV_MOUSE_BUTTON_PACKET packet {};
    packet.button = button;
    return packet_bytes(packet, release ? MOUSE_BUTTON_UP_EVENT_MAGIC_GEN5 : MOUSE_BUTTON_DOWN_EVENT_MAGIC_GEN5);
  }
  static std::vector<std::uint8_t> controller() {
    NV_MULTI_CONTROLLER_PACKET packet {};
    packet.activeGamepadMask = 1;
    packet.buttonFlags = platf::A | platf::BACK;
    packet.leftTrigger = 255;
    packet.rightTrigger = 128;
    packet.leftStickX = 32767;
    packet.leftStickY = -32768;
    packet.rightStickX = -16384;
    packet.rightStickY = 16384;
    return packet_bytes(packet, MULTI_CONTROLLER_MAGIC_GEN5);
  }
  static std::vector<std::uint8_t> touch(unsigned id) {
    SS_TOUCH_PACKET packet {};
    packet.eventType = LI_TOUCH_EVENT_DOWN;
    packet.pointerId = util::endian::little(std::uint32_t(id));
    return packet_bytes(packet, SS_TOUCH_MAGIC);
  }
  static std::vector<std::uint8_t> pen() {
    SS_PEN_PACKET packet {};
    packet.eventType = LI_TOUCH_EVENT_DOWN;
    packet.toolType = LI_TOOL_TYPE_PEN;
    packet.penButtons = LI_PEN_BUTTON_PRIMARY | LI_PEN_BUTTON_SECONDARY;
    return packet_bytes(packet, SS_PEN_MAGIC);
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

TEST_F(ClipRelayInputTest, EveryHeldMouseButtonIsReleasedBeforeAcknowledgment) {
  config::input.mouse = true;
  send(envelope(1,1)); drain();
  std::uint32_t epoch = 2;
  for (const unsigned button : {BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT, BUTTON_X1, BUTTON_X2}) {
    send(envelope(epoch,2)); drain();
    send(envelope(epoch,3,mouse(button))); drain();
    ASSERT_TRUE(platform_context->mouse->last_submitted_event().pressed);
    const auto pressed_count = platform_context->mouse->submit_count();
    send(envelope(epoch,3,mouse(button)));
    send(envelope(epoch+1,1));
    EXPECT_EQ(gate->snapshot().acknowledged,epoch);
    drain();
    EXPECT_EQ(gate->snapshot().acknowledged,epoch+1);
    EXPECT_FALSE(platform_context->mouse->last_submitted_event().pressed);
    EXPECT_EQ(platform_context->mouse->submit_count(),pressed_count+1);
    send(envelope(epoch,3,mouse(button))); drain();
    EXPECT_EQ(platform_context->mouse->submit_count(),pressed_count+1);
    epoch += 2;
  }
}

TEST_F(ClipRelayInputTest, PendingLeftReleaseIsFlushedBeforePauseAcknowledgment) {
  config::input.mouse = true;
  send(mouse(BUTTON_LEFT)); drain();
  const auto pressed_count = platform_context->mouse->submit_count();
  send(mouse(BUTTON_LEFT,true)); run_one();
  ASSERT_EQ(platform_context->mouse->submit_count(),pressed_count);
  ASSERT_TRUE(platform_context->mouse->last_submitted_event().pressed);
  send(envelope(1,1));
  EXPECT_EQ(gate->snapshot().acknowledged,0);
  drain();
  EXPECT_EQ(gate->snapshot().acknowledged,1);
  EXPECT_EQ(platform_context->mouse->submit_count(),pressed_count+1);
  EXPECT_FALSE(platform_context->mouse->last_submitted_event().pressed);
  send(envelope(2,2)); drain();
  send(envelope(2,3,mouse(BUTTON_LEFT))); drain();
  const auto new_press_count = platform_context->mouse->submit_count();
  std::this_thread::sleep_for(std::chrono::milliseconds(20)); drain();
  EXPECT_EQ(platform_context->mouse->submit_count(),new_press_count);
  EXPECT_TRUE(platform_context->mouse->last_submitted_event().pressed);
}

TEST_F(ClipRelayInputTest, RelativeModeCannotOrphanAPendingLeftRelease) {
  config::input.mouse = true;
  send(mouse(BUTTON_LEFT)); drain();
  const auto pressed_count = platform_context->mouse->submit_count();
  send(mouse(BUTTON_LEFT,true)); run_one();
  send(packet_bytes(NV_REL_MOUSE_MOVE_PACKET {},MOUSE_MOVE_REL_MAGIC_GEN5)); run_one();
  // The release precedes the relative-motion event; pause must find no old timer.
  EXPECT_EQ(platform_context->mouse->submit_count(),pressed_count+2);
  send(envelope(1,1)); drain();
  EXPECT_EQ(gate->snapshot().acknowledged,1);
  const auto paused_count = platform_context->mouse->submit_count();
  std::this_thread::sleep_for(std::chrono::milliseconds(20)); drain();
  EXPECT_EQ(platform_context->mouse->submit_count(),paused_count);
}

TEST_F(ClipRelayInputTest, DisconnectFlushesAPendingLeftRelease) {
  config::input.mouse = true;
  send(mouse(BUTTON_LEFT)); drain();
  const auto pressed_count = platform_context->mouse->submit_count();
  send(mouse(BUTTON_LEFT,true)); run_one();
  input::reset(input); drain();
  EXPECT_EQ(platform_context->mouse->submit_count(),pressed_count+1);
  EXPECT_FALSE(platform_context->mouse->last_submitted_event().pressed);
}

TEST_F(ClipRelayInputTest, NewLeftPressSupersedesDelayedReleaseUntilPause) {
  config::input.mouse = true;
  send(mouse(BUTTON_LEFT)); drain();
  send(mouse(BUTTON_LEFT,true)); run_one();
  send(mouse(BUTTON_LEFT)); run_one();
  const auto pressed_count = platform_context->mouse->submit_count();
  std::this_thread::sleep_for(std::chrono::milliseconds(20)); drain();
  EXPECT_EQ(platform_context->mouse->submit_count(),pressed_count);
  EXPECT_TRUE(platform_context->mouse->last_submitted_event().pressed);
  send(envelope(1,1)); drain();
  EXPECT_EQ(gate->snapshot().acknowledged,1);
  EXPECT_EQ(platform_context->mouse->submit_count(),pressed_count+1);
  EXPECT_FALSE(platform_context->mouse->last_submitted_event().pressed);
}

TEST_F(ClipRelayInputTest, GamepadButtonsAxesAndTouchpadAreNeutralBeforeAcknowledgment) {
  config::input.controller = true;
  config::input.gamepad = "ds4";
  config::input.gamepad_driver = config::GAMEPAD_DRIVER_VIRTUALHID;
  config::input.back_button_timeout = std::chrono::hours(1);
  const auto id = input::testing::alloc_gamepad(input,0,{LI_CTYPE_PS,LI_CCAP_TOUCHPAD,0});
  ASSERT_GE(id,0);
  auto *adapter = platf::virtualhid::gamepad_adapter_for_testing(*platform_context,id);
  ASSERT_NE(adapter,nullptr);
  send(controller()); drain();
  ASSERT_TRUE(adapter->state().buttons.test(lvh::GamepadButton::a));
  ASSERT_NE(adapter->state().left_stick.x,0.0F);
  SS_CONTROLLER_TOUCH_PACKET contact {};
  contact.eventType = LI_TOUCH_EVENT_DOWN;
  contact.pointerId = 7;
  const auto contact_bytes = packet_bytes(contact,SS_CONTROLLER_TOUCH_MAGIC);
  send(contact_bytes); drain();
  ASSERT_TRUE(adapter->state().touchpad_contacts[0].active);
  send(controller()); send(envelope(1,1));
  EXPECT_EQ(gate->snapshot().acknowledged,0);
  drain();
  EXPECT_EQ(gate->snapshot().acknowledged,1);
  const auto assert_neutral = [&] {
    for (const auto button : {lvh::GamepadButton::a,lvh::GamepadButton::back,lvh::GamepadButton::guide,lvh::GamepadButton::touchpad}) {
      EXPECT_FALSE(adapter->state().buttons.test(button));
    }
    EXPECT_FLOAT_EQ(adapter->state().left_stick.x,0.0F);
    EXPECT_FLOAT_EQ(adapter->state().left_stick.y,0.0F);
    EXPECT_FLOAT_EQ(adapter->state().right_stick.x,0.0F);
    EXPECT_FLOAT_EQ(adapter->state().right_stick.y,0.0F);
    EXPECT_FLOAT_EQ(adapter->state().left_trigger,0.0F);
    EXPECT_FLOAT_EQ(adapter->state().right_trigger,0.0F);
    EXPECT_FALSE(adapter->state().touchpad_contacts[0].active);
  };
  assert_neutral();
  send(envelope(2,2)); drain();
  send(controller()); send(envelope(1,3,controller())); send(envelope(1,3,contact_bytes)); drain();
  assert_neutral();
  EXPECT_EQ(input::testing::gamepad_id(input,0),id);
}

TEST_F(ClipRelayInputTest, TouchAndPenAreCanceledBeforeAcknowledgment) {
  config::input.mouse = true;
  auto &client = platf::virtualhid::get_client_context(input::testing::client_input(input));
  ASSERT_TRUE(client.touch); ASSERT_TRUE(client.pen);
  send(touch(7)); send(touch(8)); send(pen()); drain();
  ASSERT_EQ(client.active_touches.size(),2);
  ASSERT_EQ(client.pressed_pen_buttons.size(),2);
  const auto touch_count = client.touch->submit_count();
  send(touch(9)); send(pen()); send(envelope(1,1));
  EXPECT_EQ(gate->snapshot().acknowledged,0);
  drain();
  EXPECT_EQ(gate->snapshot().acknowledged,1);
  EXPECT_TRUE(client.active_touches.empty());
  EXPECT_TRUE(client.pressed_pen_buttons.empty());
  EXPECT_EQ(client.touch->submit_count(),touch_count+2);
  EXPECT_EQ(client.pen->last_submitted_tool().transition,lvh::PointerTransition::cancel);
  send(envelope(2,2)); drain();
  const auto paused_touch_count = client.touch->submit_count();
  const auto paused_pen_count = client.pen->submit_count();
  send(touch(10)); send(envelope(1,3,touch(11))); send(envelope(1,3,pen())); drain();
  EXPECT_EQ(client.touch->submit_count(),paused_touch_count);
  EXPECT_EQ(client.pen->submit_count(),paused_pen_count);
}
