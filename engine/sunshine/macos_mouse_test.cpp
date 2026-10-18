// SPDX-License-Identifier: GPL-3.0-only
/**
 * @file macos_mouse_test.cpp
 * @brief Exercise the real macOS pointer backend without posting system input.
 */
#ifdef __APPLE__
  #include "src/cliprelay_macos.h"
  #include "src/input.h"
  #include "src/platform/virtualhid_input.h"
  #include "src/video.h"
  #include "third-party/libvirtualhid/src/core/backend.hpp"

  #include <ApplicationServices/ApplicationServices.h>
  #include <Carbon/Carbon.h>
  #include <gtest/gtest.h>
  #include <limits>
  #include <memory>
  #include <vector>

namespace cliprelay_mouse_test {
  /** @brief Capture-free display used to exercise the real video input transform. */
  struct display: platf::display_t {
    /** @brief No capture is started by this fixture. */
    platf::capture_e capture(const push_captured_image_cb_t &, const pull_free_image_cb_t &, bool *) override {
      return platf::capture_e::error;
    }

    /** @brief No images are allocated by this fixture. */
    std::shared_ptr<platf::img_t> alloc_img() override {
      return nullptr;
    }

    /** @brief No dummy capture is performed by this fixture. */
    int dummy_img(platf::img_t *) override {
      return -1;
    }
  };

  /** @brief Copy of one event sent to the platform input boundary. */
  struct observed_event {
    CGEventType type;  ///< Event category.
    CGPoint point;  ///< Native logical position.
  };

  inline std::vector<observed_event> events;  ///< Recorded input boundary calls.
  inline CGPoint cursor {};  ///< Fixture cursor position; no system cursor changes.

  /** @brief Record an event instead of injecting it into the operating system. */
  void post(CGEventTapLocation, CGEventRef event) {
    events.push_back({CGEventGetType(event), CGEventGetLocation(event)});
  }

  /** @brief Update the fixture cursor instead of warping the system cursor. */
  CGError warp(CGPoint point) {
    cursor = point;
    return kCGErrorSuccess;
  }

  /** @brief Return the fixture cursor for a native event-source snapshot. */
  CGPoint location(CGEventRef) {
    return cursor;
  }

  /** @brief Supply a known primary monitor independently of runner hardware. */
  CGDirectDisplayID primary() {
    return 1;
  }

  /** @brief Supply the primary monitor's logical bounds for legacy input. */
  CGRect primary_bounds(CGDirectDisplayID) {
    return {{0, 0}, {1440, 900}};
  }

  /** @brief Avoid querying real monitor modes during input-source allocation. */
  CGDisplayModeRef no_mode(CGDirectDisplayID) {
    return nullptr;
  }
}  // namespace cliprelay_mouse_test

namespace video {
  /** @brief Production video-to-input transform, linked from video.cpp. */
  input::touch_port_t make_port(platf::display_t *display, const config_t &config);
}  // namespace video

  // Include the production backend under a distinct namespace, as upstream's
  // own fixture does. Only OS posting/cursor/display boundaries are replaced;
  // target transitions, held-button state and CoreGraphics event objects are real.
  #define macos cliprelay_mouse_fixture
  #define create_platform_backend create_cliprelay_mouse_test_backend
  #define CGEventPost cliprelay_mouse_test::post
  #define CGWarpMouseCursorPosition cliprelay_mouse_test::warp
  #define CGEventGetLocation cliprelay_mouse_test::location
  #define CGMainDisplayID cliprelay_mouse_test::primary
  #define CGDisplayBounds cliprelay_mouse_test::primary_bounds
  #define CGDisplayCopyDisplayMode cliprelay_mouse_test::no_mode
  #include "third-party/libvirtualhid/src/platform/macos/macos_backend.cpp"
  #undef CGDisplayCopyDisplayMode
  #undef CGDisplayBounds
  #undef CGMainDisplayID
  #undef CGEventGetLocation
  #undef CGWarpMouseCursorPosition
  #undef CGEventPost
  #undef create_platform_backend
  #undef macos

/** @brief Fixture for capture-bound native mouse input. */
class ClipRelayMacMouseTest: public ::testing::Test {
protected:
  std::shared_ptr<lvh::detail::cliprelay_mouse_fixture::MacosInputState> state;  ///< Actual event-source state.
  std::unique_ptr<lvh::detail::cliprelay_mouse_fixture::MacosMouse> mouse;  ///< Production native backend.
  lvh::PointerTarget left {1, true, {-1920, 100, 1920, 1080}};  ///< Secondary display left of primary.
  lvh::PointerTarget above {2, true, {1440, -900, 1280, 720}};  ///< Next capture above/right of primary.

  /** @brief Allocate native event objects while isolating all input effects. */
  void SetUp() override {
    cliprelay_mouse_test::events.clear();
    cliprelay_mouse_test::cursor = {-1000, 500};
    state = std::make_shared<lvh::detail::cliprelay_mouse_fixture::MacosInputState>();
    ASSERT_TRUE(state->source);
    ASSERT_TRUE(state->mouse_event);
    mouse = std::make_unique<lvh::detail::cliprelay_mouse_fixture::MacosMouse>(state);
  }

  /** @brief Close the input device before releasing its event sources. */
  void TearDown() override {
    mouse.reset();
    state.reset();
  }

  /** @brief Create an absolute event in a Retina capture's pixel coordinate space. */
  lvh::MouseEvent move(lvh::PointerTarget target, float x = 1920, float y = 1080) {
    return {.kind = lvh::MouseEventKind::absolute_motion, .absolute_x = x, .absolute_y = y, .has_fractional_absolute_coordinates = true, .width = 3840, .height = 2160, .target = target};
  }

  /** @brief Create a capture-bound button edge. */
  lvh::MouseEvent button(lvh::PointerTarget target, lvh::MouseButton which, bool down) {
    return {.kind = lvh::MouseEventKind::button, .button = which, .pressed = down, .target = target};
  }

  /** @brief Check an emitted event's native coordinate and category. */
  void event(std::size_t index, CGEventType kind, double x, double y) {
    ASSERT_LT(index, cliprelay_mouse_test::events.size());
    const auto &value = cliprelay_mouse_test::events[index];
    EXPECT_EQ(value.type, kind);
    EXPECT_DOUBLE_EQ(value.point.x, x);
    EXPECT_DOUBLE_EQ(value.point.y, y);
  }
};

TEST_F(ClipRelayMacMouseTest, SecondaryDisplayUsesLogicalBoundsAndFractionalCaptureCoordinates) {
  ASSERT_TRUE(mouse->submit(move(left, 960.25F, 1080)).ok());
  ASSERT_EQ(cliprelay_mouse_test::events.size(), 1U);
  event(0, kCGEventMouseMoved, -1439.875, 640);
  ASSERT_TRUE(mouse->submit(button(left, lvh::MouseButton::right, true)).ok());
  ASSERT_TRUE(mouse->submit(move(left, 3840, 2160)).ok());
  event(2, kCGEventRightMouseDragged, -1, 1179);
}

TEST_F(ClipRelayMacMouseTest, NewCaptureReleasesAllOldButtonsBeforeMovingAndRejectsStaleEvents) {
  for (auto which : {lvh::MouseButton::left, lvh::MouseButton::right, lvh::MouseButton::middle}) {
    ASSERT_TRUE(mouse->submit(button(left, which, true)).ok());
  }
  cliprelay_mouse_test::events.clear();
  ASSERT_TRUE(mouse->submit(move(above)).ok());
  ASSERT_EQ(cliprelay_mouse_test::events.size(), 4U);
  event(0, kCGEventLeftMouseUp, -1000, 500);
  event(1, kCGEventRightMouseUp, -1000, 500);
  event(2, kCGEventOtherMouseUp, -1000, 500);
  event(3, kCGEventMouseMoved, 2080, -540);
  EXPECT_FALSE(mouse->submit(button(left, lvh::MouseButton::left, true)).ok());
  EXPECT_FALSE(mouse->submit(button(left, lvh::MouseButton::right, false)).ok());
  EXPECT_EQ(cliprelay_mouse_test::events.size(), 4U);
}

TEST_F(ClipRelayMacMouseTest, InactiveCaptureReleasesAndCannotBeReactivatedWithinItsGeneration) {
  ASSERT_TRUE(mouse->submit(button(left, lvh::MouseButton::left, true)).ok());
  auto inactive = left;
  inactive.active = false;
  EXPECT_FALSE(mouse->submit(move(inactive)).ok());
  ASSERT_EQ(cliprelay_mouse_test::events.size(), 2U);
  event(1, kCGEventLeftMouseUp, -1000, 500);
  EXPECT_FALSE(mouse->submit(button(left, lvh::MouseButton::left, true)).ok());
  EXPECT_TRUE(mouse->submit(button(inactive, lvh::MouseButton::left, false)).ok());
  EXPECT_EQ(cliprelay_mouse_test::events.size(), 2U);
  ASSERT_TRUE(mouse->submit(move(above)).ok());
  event(2, kCGEventMouseMoved, 2080, -540);
}

TEST_F(ClipRelayMacMouseTest, MalformedOrChangedTargetsCannotAdvanceOrRetargetAnActiveCapture) {
  ASSERT_TRUE(mouse->submit(button(left, lvh::MouseButton::left, true)).ok());
  auto changed = left;
  changed.viewport.offset_x++;
  EXPECT_FALSE(mouse->submit(move(changed)).ok());
  auto invalid = above;
  invalid.generation = 999;
  invalid.viewport.width = 0;
  EXPECT_FALSE(mouse->submit(move(invalid)).ok());
  invalid = above;
  invalid.generation = 0;
  EXPECT_FALSE(mouse->submit(move(invalid)).ok());
  invalid = above;
  invalid.viewport.offset_x = std::numeric_limits<std::int32_t>::max();
  EXPECT_FALSE(mouse->submit(move(invalid)).ok());
  ASSERT_EQ(cliprelay_mouse_test::events.size(), 1U);
  ASSERT_TRUE(mouse->submit(move(left)).ok());
  event(1, kCGEventLeftMouseDragged, -960, 640);
}

TEST_F(ClipRelayMacMouseTest, ScrollTargetsCaptureAndUnboundEventsCannotBypassTargeting) {
  ASSERT_TRUE(mouse->submit(move(above)).ok());
  cliprelay_mouse_test::cursor = {0, 0};
  ASSERT_TRUE(mouse->submit({.kind = lvh::MouseEventKind::vertical_scroll,
                             .high_resolution_scroll = 120,
                             .target = above})
                .ok());
  event(1, kCGEventScrollWheel, 1440, -181);
  EXPECT_FALSE(mouse->submit({.kind = lvh::MouseEventKind::relative_motion, .x = 5, .y = 5}).ok());
  EXPECT_EQ(cliprelay_mouse_test::events.size(), 2U);
}

TEST_F(ClipRelayMacMouseTest, ClosingReleasesOnlyOwnedButtonsOnce) {
  ASSERT_TRUE(mouse->submit(button(left, lvh::MouseButton::middle, true)).ok());
  ASSERT_TRUE(mouse->close().ok());
  ASSERT_TRUE(mouse->close().ok());
  ASSERT_EQ(cliprelay_mouse_test::events.size(), 2U);
  event(1, kCGEventOtherMouseUp, -1000, 500);
  EXPECT_FALSE(mouse->submit(move(left)).ok());
}

TEST_F(ClipRelayMacMouseTest, UntargetedLegacyMouseKeepsPrimaryDisplayMappingUntilBound) {
  auto legacy = move(left);
  legacy.target.reset();
  ASSERT_TRUE(mouse->submit(legacy).ok());
  event(0, kCGEventMouseMoved, 720, 450);
  ASSERT_TRUE(mouse->submit(move(left)).ok());
  event(1, kCGEventMouseMoved, -960, 640);
  EXPECT_FALSE(mouse->submit(legacy).ok());
}

TEST_F(ClipRelayMacMouseTest, CaptureReadinessAllowsFirstFrameThenPermanentlyCancelsOldTarget) {
  cliprelay::display_control registry;
  int key;
  registry.add_stream(&key, std::string(64, 'a'), 3840, 2160);
  auto generation = registry.begin_capture({"left", -1920, 100, 1920, 1080, -1920, 0, 3360, 1180});
  registry.bind(&key, generation);
  auto target = cliprelay::macos::pointer_target(registry.snapshot());
  EXPECT_FALSE(target.active);
  EXPECT_FALSE(mouse->submit(move(target)).ok());
  registry.real_frame(&key, generation, 1);
  registry.encoded(&key, 1);
  auto active = cliprelay::macos::pointer_target(registry.snapshot());
  ASSERT_TRUE(active.active);
  EXPECT_GT(active.generation, target.generation);
  ASSERT_TRUE(mouse->submit(move(active)).ok());
  ASSERT_TRUE(mouse->submit(button(active, lvh::MouseButton::left, true)).ok());
  registry.invalidate();
  auto stopped = cliprelay::macos::pointer_target(registry.snapshot());
  EXPECT_FALSE(stopped.active);
  EXPECT_GT(stopped.generation, active.generation);
  EXPECT_FALSE(mouse->submit(move(stopped)).ok());
  EXPECT_FALSE(mouse->submit(move(active)).ok());
  generation = registry.begin_capture({"above", 1440, -900, 1280, 720, 0, -900, 2720, 1800});
  registry.bind(&key, generation);
  EXPECT_FALSE(mouse->submit(move(cliprelay::macos::pointer_target(registry.snapshot()))).ok());
  registry.real_frame(&key, generation, 2);
  registry.encoded(&key, 2);
  ASSERT_TRUE(mouse->submit(move(cliprelay::macos::pointer_target(registry.snapshot()))).ok());
  event(3, kCGEventMouseMoved, 2080, -540);
}

TEST_F(ClipRelayMacMouseTest, PendingSwitchCancelsOldDragAndNewCaptureWaitsForEncodedFrame) {
  cliprelay::display_control registry;
  int key;
  registry.catalog({"left", "above"});
  registry.add_stream(&key, std::string(64, 'a'), 3840, 2160);
  auto generation = registry.begin_capture({"left", -1920, 100, 1920, 1080});
  registry.bind(&key, generation);
  registry.real_frame(&key, generation, 1);
  registry.encoded(&key, 1);
  auto target = cliprelay::macos::pointer_target(registry.snapshot());
  ASSERT_TRUE(mouse->submit(button(target, lvh::MouseButton::right, true)).ok());
  ASSERT_EQ(registry.request("above", registry.snapshot().revision), "accepted");
  EXPECT_FALSE(mouse->submit(move(cliprelay::macos::pointer_target(registry.snapshot()))).ok());
  EXPECT_EQ(registry.take_selection({"left", "above"}, 0), 1);
  generation = registry.begin_capture({"above", 1440, -900, 1280, 720});
  registry.bind(&key, generation);
  EXPECT_FALSE(mouse->submit(move(cliprelay::macos::pointer_target(registry.snapshot()))).ok());
  registry.encoded(&key, 2);  // No real capture image has been converted yet.
  EXPECT_FALSE(cliprelay::macos::pointer_target(registry.snapshot()).active);
  registry.real_frame(&key, generation, 3);
  registry.encoded(&key, 3);
  ASSERT_TRUE(mouse->submit(move(cliprelay::macos::pointer_target(registry.snapshot()))).ok());
  ASSERT_EQ(cliprelay_mouse_test::events.size(), 3U);
  event(1, kCGEventRightMouseUp, -1000, 500);
  event(2, kCGEventMouseMoved, 2080, -540);
  EXPECT_FALSE(mouse->submit(move(target)).ok());
}

TEST_F(ClipRelayMacMouseTest, InvalidAbsoluteCoordinatesDoNotReleaseOrRetargetHeldButtons) {
  ASSERT_TRUE(mouse->submit(button(left, lvh::MouseButton::left, true)).ok());
  auto invalid = move(above);
  invalid.absolute_x = std::numeric_limits<float>::quiet_NaN();
  EXPECT_FALSE(mouse->submit(invalid).ok());
  invalid = move(above);
  invalid.absolute_y = std::numeric_limits<float>::infinity();
  EXPECT_FALSE(mouse->submit(invalid).ok());
  invalid = move(above);
  invalid.height = 0;
  EXPECT_FALSE(mouse->submit(invalid).ok());
  ASSERT_EQ(cliprelay_mouse_test::events.size(), 1U);
  ASSERT_TRUE(mouse->submit(move(left)).ok());
  event(1, kCGEventLeftMouseDragged, -960, 640);
}

TEST_F(ClipRelayMacMouseTest, LogicalGeometryKeepsNegativeOriginAndRejectsInvalidDesktopBounds) {
  using cliprelay::macos::geometry;
  auto value = geometry("42", {-1920, 100, 1920, 1080}, {-1920, 0, 3360, 1180});
  ASSERT_TRUE(value);
  EXPECT_EQ(value->id, "42");
  EXPECT_EQ(value->x, -1920);
  EXPECT_EQ(value->width, 1920);
  EXPECT_EQ(value->desktop_width, 3360);
  EXPECT_FALSE(geometry("", {0, 0, 100, 100}, {0, 0, 100, 100}));
  EXPECT_FALSE(geometry("42", {0, 0, 0, 100}, {0, 0, 100, 100}));
  EXPECT_FALSE(geometry("42", {0.5, 0, 50, 50}, {0, 0, 100, 100}));
  EXPECT_FALSE(geometry("42", {-1, 0, 100, 100}, {0, 0, 100, 100}));
  EXPECT_FALSE(geometry("42", {0, 0, 200, 100}, {0, 0, 100, 100}));
  EXPECT_FALSE(geometry("42", {0, 0, 100, 100}, {0, 0, std::numeric_limits<double>::infinity(), 100}));
}

TEST_F(ClipRelayMacMouseTest, ExhaustedCaptureVersionFailsClosedWithoutWrapping) {
  cliprelay::display_snapshot state;
  state.generation = std::numeric_limits<std::uint64_t>::max();
  auto target = cliprelay::macos::pointer_target(state);
  EXPECT_FALSE(target.active);
  EXPECT_EQ(target.generation, std::numeric_limits<std::uint64_t>::max());
  EXPECT_FALSE(mouse->submit(move(target)).ok());
  EXPECT_FALSE(mouse->submit(move(left)).ok());
  EXPECT_TRUE(cliprelay_mouse_test::events.empty());
}

TEST_F(ClipRelayMacMouseTest, VideoInputTransformRetainsCapturePixelsAndLetterboxScaling) {
  cliprelay_mouse_test::display display;
  display.width = display.env_width = 3840;
  display.height = display.env_height = 2160;
  display.cliprelay_capture_x = -1920;
  display.cliprelay_capture_y = 100;
  display.cliprelay_capture_width = 1920;
  display.cliprelay_capture_height = 1080;
  display.cliprelay_desktop_x = -1920;
  display.cliprelay_desktop_width = 3360;
  display.cliprelay_desktop_height = 1180;
  video::config_t config {};
  config.width = 1920;
  config.height = 1200;
  const auto port = video::make_port(&display, config);
  EXPECT_EQ(port.env_width, 3840);
  EXPECT_EQ(port.env_height, 2160);
  EXPECT_EQ(port.env_logical_width, 0);
  EXPECT_EQ(port.env_logical_height, 0);
  EXPECT_FLOAT_EQ(port.scalar_inv, 2.0F);
  EXPECT_FLOAT_EQ(port.scalar_tpcoords, 1.0F);
  EXPECT_FLOAT_EQ(port.client_offsetX, 0.0F);
  EXPECT_FLOAT_EQ(port.client_offsetY, 60.0F);
}

TEST_F(ClipRelayMacMouseTest, ProductionAdapterAttachesCaptureTargetToEveryMouseEvent) {
  /** @brief Remove only this fixture's stream when any assertion ends the test. */
  struct stream_guard {
    int key;

    ~stream_guard() {
      cliprelay::displays.remove_stream(&key);
    }
  } owner;

  cliprelay::displays.add_stream(&owner.key, std::string(64, 'b'), 3840, 2160);
  const auto generation = cliprelay::displays.begin_capture({"left", -1920, 100, 1920, 1080});
  cliprelay::displays.bind(&owner.key, generation);
  cliprelay::displays.real_frame(&owner.key, generation, 1);
  cliprelay::displays.encoded(&owner.key, 1);
  platf::virtualhid::input_context_t context {lvh::BackendKind::fake};
  ASSERT_TRUE(context.mouse);
  platf::virtualhid::move_mouse(context, 1, -2);
  auto event = context.mouse->last_submitted_event();
  ASSERT_TRUE(event.target);
  EXPECT_TRUE(event.target->active);
  EXPECT_EQ(event.target->viewport.offset_x, -1920);
  EXPECT_EQ(event.kind, lvh::MouseEventKind::relative_motion);
  const auto target_generation = event.target->generation;
  platf::touch_port_t port {};
  port.width = 3840;
  port.height = 2160;
  platf::virtualhid::abs_mouse(context, port, 960.25F, 1080);
  event = context.mouse->last_submitted_event();
  ASSERT_TRUE(event.target);
  EXPECT_EQ(event.target->generation, target_generation);
  EXPECT_TRUE(event.has_fractional_absolute_coordinates);
  EXPECT_FLOAT_EQ(event.absolute_x, 960.25F);
  EXPECT_EQ(event.width, 3840);
  platf::virtualhid::button_mouse(context, 1, false);
  event = context.mouse->last_submitted_event();
  ASSERT_TRUE(event.target);
  EXPECT_EQ(event.target->generation, target_generation);
  EXPECT_EQ(event.kind, lvh::MouseEventKind::button);
  platf::virtualhid::scroll(context, 120);
  event = context.mouse->last_submitted_event();
  ASSERT_TRUE(event.target);
  EXPECT_EQ(event.target->generation, target_generation);
  EXPECT_EQ(event.kind, lvh::MouseEventKind::vertical_scroll);
  platf::virtualhid::hscroll(context, -120);
  event = context.mouse->last_submitted_event();
  ASSERT_TRUE(event.target);
  EXPECT_EQ(event.target->generation, target_generation);
  EXPECT_EQ(event.kind, lvh::MouseEventKind::horizontal_scroll);
  cliprelay::displays.invalidate();
  platf::virtualhid::button_mouse(context, 1, true);
  event = context.mouse->last_submitted_event();
  ASSERT_TRUE(event.target);
  EXPECT_FALSE(event.target->active);
  EXPECT_GT(event.target->generation, target_generation);
}
#endif
