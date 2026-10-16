// SPDX-License-Identifier: GPL-3.0-only
/**
 * @file macos_capture_test.mm
 * @brief Exercise the production capture mailbox without capturing any screen.
 */
#ifdef __APPLE__
  #include "src/cliprelay_capture.h"
  #import "src/platform/macos/av_video.h"

  #include <atomic>
  #include <chrono>
  #include <future>
  #include <gtest/gtest.h>
  #include <memory>
  #include <thread>

/** @brief Session boundary that never opens a camera or screen capture device. */
@interface ClipRelayCaptureTestSession: NSObject
@property (nonatomic, retain) NSMutableArray *outputs;  ///< Registered outputs.
@property (nonatomic) BOOL running;  ///< Simulated session state.
@property (nonatomic) BOOL refuse;  ///< Simulate unsupported output creation.
@property (nonatomic) NSUInteger stops;  ///< Stop calls visible to this boundary.
- (BOOL)canAddOutput:(id)output;  ///< Simulate output admission.
- (void)addOutput:(id)output;  ///< Retain a registered output.
- (void)removeOutput:(id)output;  ///< Remove exactly one output.
- (void)beginConfiguration;  ///< Begin an inert configuration transaction.
- (void)commitConfiguration;  ///< Commit an inert configuration transaction.
- (BOOL)isRunning;  ///< Read the simulated running state.
- (void)startRunning;  ///< Mark the fake session running.
- (void)stopRunning;  ///< Mark the fake session stopped.
@end

@implementation ClipRelayCaptureTestSession

- (id)init {
  self = [super init];
  if (self) {
    self.outputs = [NSMutableArray array];
  }
  return self;
}

- (BOOL)canAddOutput:(id)output {
  return output && !self.refuse;
}

- (void)addOutput:(id)output {
  [self.outputs addObject:output];
}

- (void)removeOutput:(id)output {
  [self.outputs removeObjectIdenticalTo:output];
}

- (void)beginConfiguration {
}

- (void)commitConfiguration {
}

- (BOOL)isRunning {
  return self.running;
}

- (void)startRunning {
  self.running = YES;
}

- (void)stopRunning {
  self.running = NO;
  self.stops++;
}

- (void)dealloc {
  [self.outputs release];
  [super dealloc];
}

@end

/** @brief Fixture with real mailbox/delegate/queues and a fake session boundary. */
class ClipRelayMacCaptureTest: public ::testing::Test {
protected:
  AVVideo *owner = nil;  ///< Production session owner, with no native screen input.
  ClipRelayCaptureTestSession *session = nil;  ///< Inert AVFoundation session boundary.
  std::atomic<int> freed {0};  ///< Exact lifetime of fixture-owned pixel storage.
  NSAutoreleasePool *pool = nil;  ///< Foundation allocations for this test thread.

  /** @brief Configure the owner without running initWithDisplay or capture APIs. */
  void SetUp() override {
    pool = [[NSAutoreleasePool alloc] init];
    owner = [[AVVideo alloc] init];
    session = [[ClipRelayCaptureTestSession alloc] init];
    owner.session = (AVCaptureSession *) session;
    owner.frameSources = [[NSMutableArray alloc] init];
    owner.frameWidth = owner.frameHeight = 16;
    owner.pixelFormat = kCVPixelFormatType_32BGRA;
  }

  /** @brief Drain all registered sources before destroying test counters. */
  void TearDown() override {
    [owner release];
    [pool drain];
  }

  /** @brief Count the actual final release of synthetic pixel storage. */
  static void release_pixels(void *context, const void *pixels) {
    delete[] static_cast<const unsigned char *>(pixels);
    ++*static_cast<std::atomic<int> *>(context);
  }

  /** @brief Make a real retained CoreMedia image sample without screen capture. */
  CMSampleBufferRef sample() {
    CVPixelBufferRef pixels = nullptr;
    auto bytes = new unsigned char[16 * 16 * 4] {};
    auto result = CVPixelBufferCreateWithBytes(kCFAllocatorDefault, 16, 16, kCVPixelFormatType_32BGRA, bytes, 16 * 4, release_pixels, &freed, nullptr, &pixels);
    EXPECT_EQ(result, kCVReturnSuccess);
    if (result != kCVReturnSuccess) {
      delete[] bytes;
      return nullptr;
    }
    CMVideoFormatDescriptionRef format = nullptr;
    EXPECT_EQ(CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixels, &format), noErr);
    CMSampleTimingInfo timing {CMTimeMake(1, 60), CMTimeMake(1, 60), kCMTimeInvalid};
    CMSampleBufferRef value = nullptr;
    EXPECT_EQ(CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixels, format, &timing, &value), noErr);
    if (format) {
      CFRelease(format);
    }
    CFRelease(pixels);
    return value;
  }

  /** @brief Deliver a synthetic frame through the real AVFoundation delegate method. */
  static void deliver(AVVideoFrameSource *source, CMSampleBufferRef value) {
    [source captureOutput:source.output didOutputSampleBuffer:value fromConnection:nil];
  }
};

TEST_F(ClipRelayMacCaptureTest, LatestFrameReplacesPendingStorageAndTransfersOneOwnedSample) {
  auto source = [owner newCapture];
  ASSERT_NE(source, nil);
  auto first = sample();
  ASSERT_NE(first, nullptr);
  deliver(source, first);
  CFRelease(first);
  EXPECT_EQ(freed.load(), 0);
  auto second = sample();
  ASSERT_NE(second, nullptr);
  deliver(source, second);
  CFRelease(second);
  EXPECT_EQ(freed.load(), 1);
  auto received = [source copyNextFrameBefore:DISPATCH_TIME_NOW];
  ASSERT_EQ(received, second);
  EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_NOW], nullptr);
  [owner stopCapture:source];
  [source release];
  EXPECT_EQ(freed.load(), 1);
  CFRelease(received);
  EXPECT_EQ(freed.load(), 2);
}

TEST_F(ClipRelayMacCaptureTest, EmptySourceTimesOutAndCancellationWakesWaitingReader) {
  using namespace std::chrono_literals;
  auto source = [owner newCapture];
  ASSERT_NE(source, nil);
  const auto started = std::chrono::steady_clock::now();
  EXPECT_EQ([source copyNextFrameBefore:dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_MSEC)], nullptr);
  EXPECT_LT(std::chrono::steady_clock::now() - started, 5s);
  std::promise<void> entered;
  auto reader = std::async(std::launch::async, [&] {
    @autoreleasepool {
      entered.set_value();
      return [source copyNextFrameBefore:dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC)];
    }
  });
  entered.get_future().wait();
  EXPECT_EQ(reader.wait_for(20ms), std::future_status::timeout);
  [owner stopCapture:source];
  EXPECT_EQ(reader.wait_for(5s), std::future_status::ready);
  EXPECT_EQ(reader.get(), nullptr);
  EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_FOREVER], nullptr);
  [source release];
}

TEST_F(ClipRelayMacCaptureTest, StopReleasesPendingFrameAndRejectsLateDelegateDelivery) {
  auto source = [owner newCapture];
  ASSERT_NE(source, nil);
  auto first = sample();
  deliver(source, first);
  CFRelease(first);
  [owner stopCapture:source];
  EXPECT_EQ(freed.load(), 1);
  auto late = sample();
  deliver(source, late);
  CFRelease(late);
  EXPECT_EQ(freed.load(), 2);
  EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_NOW], nullptr);
  [owner stopCapture:source];
  [source release];
}

TEST_F(ClipRelayMacCaptureTest, StopWaitsForQueuedDelegateWorkBeforeReturning) {
  using namespace std::chrono_literals;
  auto source = [owner newCapture];
  ASSERT_NE(source, nil);
  auto queue = source.output.sampleBufferCallbackQueue;
  auto gate = dispatch_semaphore_create(0);
  auto entered = dispatch_semaphore_create(0);
  auto value = sample();
  dispatch_async(queue, ^{
    dispatch_semaphore_signal(entered);
    dispatch_semaphore_wait(gate, DISPATCH_TIME_FOREVER);
    deliver(source, value);
  });
  ASSERT_EQ(dispatch_semaphore_wait(entered, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)), 0);
  auto stop = std::async(std::launch::async, [&] {
    @autoreleasepool {
      [owner stopCapture:source];
    }
  });
  EXPECT_EQ(stop.wait_for(20ms), std::future_status::timeout);
  dispatch_semaphore_signal(gate);
  EXPECT_EQ(stop.wait_for(5s), std::future_status::ready);
  stop.get();
  CFRelease(value);
  EXPECT_EQ(freed.load(), 1);
  EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_NOW], nullptr);
  [source release];
  dispatch_release(gate);
  dispatch_release(entered);
}

TEST_F(ClipRelayMacCaptureTest, RemovingOneOutputPreservesAnotherOwnersCapture) {
  auto first = [owner newCapture];
  auto second = [owner newCapture];
  ASSERT_NE(first, nil);
  ASSERT_NE(second, nil);
  EXPECT_EQ(session.outputs.count, 2U);
  const auto stops = session.stops;
  [owner stopCapture:first];
  EXPECT_EQ(session.outputs.count, 1U);
  EXPECT_EQ(session.stops, stops);
  EXPECT_TRUE(session.running);
  auto value = sample();
  deliver(second, value);
  CFRelease(value);
  auto received = [second copyNextFrameBefore:DISPATCH_TIME_NOW];
  ASSERT_NE(received, nullptr);
  CFRelease(received);
  [owner stopCapture:second];
  EXPECT_FALSE(session.running);
  EXPECT_EQ(session.outputs.count, 0U);
  EXPECT_EQ(session.stops, stops + 1);
  [first release];
  [second release];
}

TEST_F(ClipRelayMacCaptureTest, OutputAdmissionFailureLeavesExistingCaptureRunning) {
  auto first = [owner newCapture];
  ASSERT_NE(first, nil);
  session.refuse = YES;
  EXPECT_EQ([owner newCapture], nil);
  EXPECT_EQ(session.outputs.count, 1U);
  EXPECT_TRUE(session.running);
  [owner stopCapture:first];
  [first release];
}

TEST_F(ClipRelayMacCaptureTest, ForeignOwnerCannotStopAnotherOwnersOutput) {
  auto source = [owner newCapture];
  ASSERT_NE(source, nil);
  auto foreign = [[AVVideo alloc] init];
  foreign.frameSources = [[NSMutableArray alloc] init];
  [foreign stopCapture:source];
  auto value = sample();
  ASSERT_NE(value, nullptr);
  deliver(source, value);
  CFRelease(value);
  auto received = [source copyNextFrameBefore:DISPATCH_TIME_NOW];
  ASSERT_NE(received, nullptr);
  CFRelease(received);
  EXPECT_EQ(owner.frameSources.count, 1U);
  [foreign release];
  [owner stopCapture:source];
  [source release];
}

TEST_F(ClipRelayMacCaptureTest, OwnerDestructionCancelsCallerRetainedSourceAndReleasesPixels) {
  auto source = [owner newCapture];
  ASSERT_NE(source, nil);
  auto value = sample();
  ASSERT_NE(value, nullptr);
  deliver(source, value);
  CFRelease(value);
  [owner release];
  owner = nil;
  EXPECT_EQ(freed.load(), 1);
  EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_FOREVER], nullptr);
  EXPECT_EQ(source.output.sampleBufferDelegate, nil);
  [source release];
}

TEST_F(ClipRelayMacCaptureTest, MissingFramesCannotRefreshRecoveryDeadline) {
  using namespace std::chrono_literals;
  auto clock = std::chrono::steady_clock::time_point {};
  const auto thread = std::this_thread::get_id();
  int polls = 0, idle = 0;
  const auto result = cliprelay::capture_loop(
    [&](auto budget) {
      EXPECT_LE(budget, 100ms);
      clock += budget;
      polls++;
      return std::unique_ptr<int> {};
    },
    [](auto &) {
      ADD_FAILURE() << "An empty poll must not process a frame";
      return cliprelay::frame_result::error;
    },
    [&] {
      EXPECT_EQ(std::this_thread::get_id(), thread);
      idle++;
      return polls < 100;
    },
    [] {
      return true;
    },
    [&] {
      return clock;
    }
  );
  EXPECT_EQ(result, cliprelay::capture_result::reinit);
  EXPECT_EQ(clock.time_since_epoch(), 3s);
  EXPECT_EQ(polls, idle);
}

TEST_F(ClipRelayMacCaptureTest, EmptyFramePollStillProcessesStopRequest) {
  using namespace std::chrono_literals;
  auto clock = std::chrono::steady_clock::time_point {};
  int polls = 0;
  const auto result = cliprelay::capture_loop(
    [&](auto budget) {
      clock += budget;
      polls++;
      return std::unique_ptr<int> {};
    },
    [](auto &) {
      return cliprelay::frame_result::error;
    },
    [&] {
      return polls < 2;
    },
    [] {
      return true;
    },
    [&] {
      return clock;
    }
  );
  EXPECT_EQ(result, cliprelay::capture_result::stopped);
  EXPECT_EQ(clock.time_since_epoch(), 200ms);
}

TEST_F(ClipRelayMacCaptureTest, GeometryOrPermissionChangeReinitializesBeforeMoreFrames) {
  using namespace std::chrono_literals;
  auto clock = std::chrono::steady_clock::time_point {};
  const auto thread = std::this_thread::get_id();
  int checks = 0, frames = 0;
  const auto result = cliprelay::capture_loop(
    [&](auto) {
      clock += 20ms;
      return std::make_unique<int>(1);
    },
    [&](auto &) {
      EXPECT_EQ(std::this_thread::get_id(), thread);
      frames++;
      return cliprelay::frame_result::keep_going;
    },
    [] {
      ADD_FAILURE() << "No timeout expected";
      return false;
    },
    [&] {
      return ++checks < 2;
    },
    [&] {
      return clock;
    }
  );
  EXPECT_EQ(result, cliprelay::capture_result::reinit);
  EXPECT_EQ(checks, 2);
  EXPECT_GT(frames, 0);
  EXPECT_LE(clock.time_since_epoch(), 120ms);
}

TEST_F(ClipRelayMacCaptureTest, ProcessingFailureReleasesTheOwnedSample) {
  int releases = 0;
  const auto release = [&](int *value) {
    ++releases;
    delete value;
  };
  const auto result = cliprelay::capture_loop(
    [&](auto) {
      return std::unique_ptr<int, decltype(release)>(new int(1), release);
    },
    [](auto &) {
      return cliprelay::frame_result::error;
    },
    [] {
      return true;
    },
    [] {
      return true;
    },
    [] {
      return std::chrono::steady_clock::now();
    }
  );
  EXPECT_EQ(result, cliprelay::capture_result::error);
  EXPECT_EQ(releases, 1);
}

TEST_F(ClipRelayMacCaptureTest, OnlyARealFrameRestartsTheStallDeadline) {
  using namespace std::chrono_literals;
  auto clock = std::chrono::steady_clock::time_point {};
  int frames = 0, polls = 0;
  const auto result = cliprelay::capture_loop(
    [&](auto budget) {
      clock += budget;
      ++polls;
      return clock.time_since_epoch() == 2500ms ? std::make_unique<int>(1) : std::unique_ptr<int> {};
    },
    [&](auto &) {
      ++frames;
      return cliprelay::frame_result::keep_going;
    },
    [&] {
      return polls < 100;
    },
    [] {
      return true;
    },
    [&] {
      return clock;
    }
  );
  EXPECT_EQ(result, cliprelay::capture_result::reinit);
  EXPECT_EQ(frames, 1);
  EXPECT_EQ(clock.time_since_epoch(), 5500ms);
}
#endif
