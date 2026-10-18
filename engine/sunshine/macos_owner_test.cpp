// SPDX-License-Identifier: GPL-3.0-only
/** @file macos_owner_test.cpp @brief Actual Mac pipe ownership and monitor lifecycle tests. */
#ifdef __APPLE__
  #include "src/cliprelay_owner.h"
  #include "src/httpcommon.h"

  #include <fcntl.h>
  #include <filesystem>
  #include <gtest/gtest.h>

/** @brief Own disposable descriptors without starting any host or reading user state. */
class ClipRelayMacOwnerTest: public testing::Test {
protected:
  int pipe_[2] {-1, -1};  ///< Fixture-only ownership pipe.
  std::filesystem::path credential_root_;  ///< Optional disposable certificate fixture directory.

  /** @brief Open a private test pipe. */
  void SetUp() override {
    ASSERT_EQ(pipe(pipe_), 0);
  }

  /** @brief Close only descriptors owned by this fixture. */
  void TearDown() override {
    for (auto descriptor : pipe_) {
      if (descriptor >= 0) {
        close(descriptor);
      }
    }
    if (!credential_root_.empty()) {
      std::error_code ignored;
      std::filesystem::remove_all(credential_root_, ignored);
    }
  }

  /** @brief Wait for an observed monitor callback with a bounded deadline. */
  bool wait(const std::atomic<int> &value) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (value.load() == 0 && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return value.load() != 0;
  }
};

TEST_F(ClipRelayMacOwnerTest, AdmitsPipeAndConnectedUnixStreamOnly) {
  using namespace cliprelay::macos;
  ASSERT_TRUE(owner_admitted(pipe_[0], std::to_string(getppid()).c_str()));
  int sockets[2];
  ASSERT_EQ(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets), 0);
  EXPECT_TRUE(owner_pipe(sockets[0]));
  close(sockets[0]);
  close(sockets[1]);
  ASSERT_EQ(socketpair(AF_UNIX, SOCK_DGRAM, 0, sockets), 0);
  EXPECT_FALSE(owner_pipe(sockets[0]));
  close(sockets[0]);
  close(sockets[1]);
  const int file = open("/dev/null", O_RDONLY);
  ASSERT_GE(file, 0);
  EXPECT_FALSE(owner_pipe(file));
  close(file);
  EXPECT_FALSE(owner_pipe(-1));
}

TEST_F(ClipRelayMacOwnerTest, RejectsAlreadyClosedOrUnexpectedInput) {
  using namespace cliprelay::macos;
  ASSERT_EQ(write(pipe_[1], "x", 1), 1);
  EXPECT_FALSE(owner_admitted(pipe_[0], std::to_string(getppid()).c_str()));
  char value;
  ASSERT_EQ(read(pipe_[0], &value, 1), 1);
  close(pipe_[1]);
  pipe_[1] = -1;
  EXPECT_FALSE(owner_admitted(pipe_[0], std::to_string(getppid()).c_str()));
}

TEST_F(ClipRelayMacOwnerTest, PipeEOFRequestsCleanupExactlyOnce) {
  std::atomic<int> lost {0}, forced {0};
  cliprelay::macos::owner_monitor monitor(pipe_[0], getppid(), [&] {
    ++lost;
  },
                                          [&] {
                                            ++forced;
                                          });
  close(pipe_[1]);
  pipe_[1] = -1;
  ASSERT_TRUE(wait(lost));
  EXPECT_FALSE(monitor.connected());
  EXPECT_EQ(lost.load(), 1);
  EXPECT_EQ(forced.load(), 0);
}

TEST_F(ClipRelayMacOwnerTest, TeardownJoinsWithoutTakingDescriptorOwnership) {
  std::atomic<int> lost {0};
  {
    cliprelay::macos::owner_monitor monitor(pipe_[0], getppid(), [&] {
      ++lost;
    },
                                            [] {
                                            });
  }
  EXPECT_EQ(lost.load(), 0);
  EXPECT_NE(fcntl(pipe_[0], F_GETFD), -1);
}

TEST_F(ClipRelayMacOwnerTest, LostParentCannotBeHiddenByAnOpenPipe) {
  std::atomic<int> lost {0};
  cliprelay::macos::owner_monitor monitor(pipe_[0], 1, [&] {
    ++lost;
  },
                                          [] {
                                          });
  ASSERT_TRUE(wait(lost));
  EXPECT_FALSE(monitor.connected());
}

TEST_F(ClipRelayMacOwnerTest, UnfinishedCleanupHasAHardDeadline) {
  std::atomic<int> lost {0}, forced {0};
  cliprelay::macos::owner_monitor monitor(pipe_[0], getppid(), [&] {
    ++lost;
  },
                                          [&] {
                                            ++forced;
                                          },
                                          std::chrono::milliseconds(50));
  close(pipe_[1]);
  pipe_[1] = -1;
  ASSERT_TRUE(wait(forced));
  EXPECT_EQ(lost.load(), 1);
  EXPECT_EQ(forced.load(), 1);
}

TEST_F(ClipRelayMacOwnerTest, GeneratedTLSFilesPreservePrivateStatePermissions) {
  auto temporary = (std::filesystem::temp_directory_path() / "cliprelay-owner-credentials-XXXXXX").string();
  ASSERT_NE(mkdtemp(temporary.data()), nullptr);
  credential_root_ = temporary;
  const auto key = credential_root_ / "cakey.pem";
  const auto certificate = credential_root_ / "cacert.pem";
  ASSERT_EQ(http::create_creds(key.string(), certificate.string()), 0);
  for (const auto &file : {key, certificate}) {
    struct stat info {};
    ASSERT_EQ(lstat(file.c_str(), &info), 0);
    EXPECT_TRUE(S_ISREG(info.st_mode));
    EXPECT_EQ(info.st_mode & 07777, 0600);
    EXPECT_EQ(info.st_uid, geteuid());
    EXPECT_EQ(info.st_nlink, 1);
    EXPECT_GT(info.st_size, 0);
  }
}
#endif
