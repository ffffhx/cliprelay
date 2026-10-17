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

/** @brief Native stream boundary that never opens a screen capture device. */
@interface ClipRelayCaptureTestStream: NSObject <ClipRelayCaptureStream>
@property (nonatomic, retain) id<SCStreamOutput> output;
@property (nonatomic) dispatch_queue_t queue;
@property (nonatomic) BOOL running;
@property (nonatomic) BOOL refuse;
@property (nonatomic) BOOL failStart;
@property (nonatomic) BOOL delayStart;
@property (nonatomic, copy) void (^pendingStart)(NSError *);
@property (nonatomic) NSUInteger stops;
- (void)finishStart;
@end

@implementation ClipRelayCaptureTestStream
- (BOOL)addStreamOutput:(id<SCStreamOutput>)output type:(SCStreamOutputType)type sampleHandlerQueue:(dispatch_queue_t)queue error:(NSError **)error {
  if (!output || self.refuse || self.output || type != SCStreamOutputTypeScreen) return NO;
  self.output = output;
  self.queue = queue;
  return YES;
}
- (BOOL)removeStreamOutput:(id<SCStreamOutput>)output type:(SCStreamOutputType)type error:(NSError **)error {
  if (self.output != output || type != SCStreamOutputTypeScreen) return NO;
  self.output = nil;
  return YES;
}
- (void)startCaptureWithCompletionHandler:(void (^)(NSError *))handler {
  if (self.delayStart) {
    self.pendingStart = handler;
    return;
  }
  self.running = !self.failStart;
  handler(self.failStart ? [NSError errorWithDomain:@"fixture" code:1 userInfo:nil] : nil);
}
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))handler {
  self.running = NO;
  self.stops++;
  handler(nil);
}
- (void)finishStart {
  auto callback = [self.pendingStart copy];
  self.pendingStart = nil;
  self.running = YES;
  callback(nil);
  [callback release];
}
- (void)dealloc {
  [self.output release];
  [self.pendingStart release];
  [super dealloc];
}
@end

/** @brief Real capture controller with only the system stream factory replaced. */
@interface ClipRelayCaptureTestVideo: AVVideo
@property (nonatomic, retain) NSMutableArray<ClipRelayCaptureTestStream *> *streams;
@property (nonatomic) BOOL refuse;
@end

@implementation ClipRelayCaptureTestVideo
- (id<ClipRelayCaptureStream>)newStreamExcludingWindows:(NSArray<SCWindow *> *)windows {
  auto stream = [[ClipRelayCaptureTestStream alloc] init];
  stream.refuse = self.refuse;
  [self.streams addObject:stream];
  return stream;
}
- (void)dealloc {
  [self.streams release];
  [super dealloc];
}
@end

/** @brief Fixture with real mailbox/delegate/queues and a fake session boundary. */
class ClipRelayMacCaptureTest: public ::testing::Test {
protected:
  ClipRelayCaptureTestVideo *owner = nil;  ///< Production controller with an inert stream factory.
  std::atomic<int> freed {0};  ///< Exact lifetime of fixture-owned pixel storage.
  NSAutoreleasePool *pool = nil;  ///< Foundation allocations for this test thread.

  /** @brief Configure the owner without running initWithDisplay or capture APIs. */
  void SetUp() override {
    pool = [[NSAutoreleasePool alloc] init];
    owner = [[ClipRelayCaptureTestVideo alloc] init];
    owner.streams = [NSMutableArray array];
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
    if (value) {
      auto attachments = CMSampleBufferGetSampleAttachmentsArray(value, YES);
      auto metadata = (NSMutableDictionary *)CFArrayGetValueAtIndex(attachments, 0);
      metadata[SCStreamFrameInfoStatus] = @(SCFrameStatusComplete);
    }
    return value;
  }

  /** @brief Deliver a synthetic image through the production ScreenCaptureKit callback. */
  static void deliver(AVVideoFrameSource *source, CMSampleBufferRef value) {
    [source stream:(SCStream *)source.stream didOutputSampleBuffer:value ofType:SCStreamOutputTypeScreen];
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
  auto queue = source.queue;
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
  auto firstStream = (ClipRelayCaptureTestStream *)first.stream;
  auto secondStream = (ClipRelayCaptureTestStream *)second.stream;
  EXPECT_EQ(owner.frameSources.count, 2U);
  [owner stopCapture:first];
  EXPECT_EQ(owner.frameSources.count, 1U);
  EXPECT_EQ(firstStream.stops, 1U);
  EXPECT_FALSE(firstStream.running);
  EXPECT_EQ(secondStream.stops, 0U);
  EXPECT_TRUE(secondStream.running);
  auto value = sample();
  deliver(second, value);
  CFRelease(value);
  auto received = [second copyNextFrameBefore:DISPATCH_TIME_NOW];
  ASSERT_NE(received, nullptr);
  CFRelease(received);
  [owner stopCapture:second];
  EXPECT_FALSE(secondStream.running);
  EXPECT_EQ(owner.frameSources.count, 0U);
  EXPECT_EQ(secondStream.stops, 1U);
  [first release];
  [second release];
}

TEST_F(ClipRelayMacCaptureTest, OutputAdmissionFailureLeavesExistingCaptureRunning) {
  auto first = [owner newCapture];
  ASSERT_NE(first, nil);
  owner.refuse = YES;
  EXPECT_EQ([owner newCapture], nil);
  EXPECT_EQ(owner.frameSources.count, 1U);
  EXPECT_TRUE(((ClipRelayCaptureTestStream *)first.stream).running);
  [owner stopCapture:first];
  [first release];
}

TEST_F(ClipRelayMacCaptureTest, StartFailureDetachesOutputAndStopsOnlyFailedStream) {
  auto stream = [[ClipRelayCaptureTestStream alloc] init];
  stream.failStart = YES;
  EXPECT_EQ([[AVVideoFrameSource alloc] initWithStream:stream], nil);
  EXPECT_EQ(stream.output, nil);
  EXPECT_FALSE(stream.running);
  EXPECT_EQ(stream.stops, 1U);
  [stream release];
}

TEST_F(ClipRelayMacCaptureTest, LateSuccessfulStartAfterTimeoutIsStoppedAgain) {
  using namespace std::chrono_literals;
  auto stream = [[ClipRelayCaptureTestStream alloc] init];
  stream.delayStart = YES;
  const auto began = std::chrono::steady_clock::now();
  EXPECT_EQ([[AVVideoFrameSource alloc] initWithStream:stream], nil);
  EXPECT_LT(std::chrono::steady_clock::now() - began, 5s);
  EXPECT_EQ(stream.output, nil);
  EXPECT_EQ(stream.stops, 1U);
  [stream finishStart];
  EXPECT_FALSE(stream.running);
  EXPECT_EQ(stream.stops, 2U);
  [stream release];
}

TEST_F(ClipRelayMacCaptureTest, IdleBlankSuspendedAndStoppedNotificationsCannotBecomeFrames) {
  auto source = [owner newCapture];
  ASSERT_NE(source, nil);
  auto value = sample();
  auto metadata = (NSMutableDictionary *)CFArrayGetValueAtIndex(CMSampleBufferGetSampleAttachmentsArray(value, YES), 0);
  for (auto status : {SCFrameStatusIdle, SCFrameStatusBlank, SCFrameStatusSuspended, SCFrameStatusStopped, SCFrameStatusStarted}) {
    metadata[SCStreamFrameInfoStatus] = @(status);
    deliver(source, value);
    EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_NOW], nullptr);
  }
  metadata[SCStreamFrameInfoStatus] = @(SCFrameStatusComplete);
  deliver(source, value);
  auto received = [source copyNextFrameBefore:DISPATCH_TIME_NOW];
  ASSERT_NE(received, nullptr);
  CFRelease(received);
  CFRelease(value);
  [owner stopCapture:source];
  [source release];
  EXPECT_EQ(freed.load(), 1);
}

TEST_F(ClipRelayMacCaptureTest, MissingOrMalformedFrameStatusIsRejected) {
  auto source = [owner newCapture];
  ASSERT_NE(source, nil);
  auto value = sample();
  auto metadata = (NSMutableDictionary *)CFArrayGetValueAtIndex(CMSampleBufferGetSampleAttachmentsArray(value, YES), 0);
  [metadata removeObjectForKey:SCStreamFrameInfoStatus];
  deliver(source, value);
  EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_NOW], nullptr);
  metadata[SCStreamFrameInfoStatus] = @"complete";
  deliver(source, value);
  EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_NOW], nullptr);
  CFRelease(value);
  [owner stopCapture:source];
  [source release];
  EXPECT_EQ(freed.load(), 1);
}

TEST_F(ClipRelayMacCaptureTest, ForeignStreamAndAudioCallbacksCannotDeliverImages) {
  auto source = [owner newCapture];
  auto foreign = [owner newCapture];
  ASSERT_NE(source, nil);
  ASSERT_NE(foreign, nil);
  auto value = sample();
  [source stream:(SCStream *)foreign.stream didOutputSampleBuffer:value ofType:SCStreamOutputTypeScreen];
  [source stream:(SCStream *)source.stream didOutputSampleBuffer:value ofType:SCStreamOutputTypeAudio];
  EXPECT_EQ([source copyNextFrameBefore:DISPATCH_TIME_NOW], nullptr);
  CFRelease(value);
  [owner stopCapture:source];
  [owner stopCapture:foreign];
  [source release];
  [foreign release];
  EXPECT_EQ(freed.load(), 1);
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
  EXPECT_EQ(((ClipRelayCaptureTestStream *)source.stream).output, nil);
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
