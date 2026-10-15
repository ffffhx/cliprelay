// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <vector>

namespace cliprelay {
  // Inside the existing authenticated/encrypted input transport. The envelope
  // is 16 bytes: NV length BE32, magic LE32, epoch BE32, operation, three zeros.
  // A data envelope contains one complete, independently validated NV packet.
  constexpr std::uint32_t input_magic = 0x4352494e;
  enum class input_op : std::uint8_t { invalid, pause, resume, data, legacy };
  struct input_packet { input_op op = input_op::invalid; std::uint32_t epoch = 0; };
  inline std::uint32_t input_be32(const std::uint8_t *p) {
    return (std::uint32_t(p[0]) << 24) | (std::uint32_t(p[1]) << 16) | (std::uint32_t(p[2]) << 8) | p[3];
  }
  inline input_packet parse_input(std::span<const std::uint8_t> bytes) {
    if (bytes.size() < 8) return {};
    if (bytes[4] != 0x4e || bytes[5] != 0x49 || bytes[6] != 0x52 || bytes[7] != 0x43) return {input_op::legacy, 0};
    if (bytes.size() < 16 || bytes.size() > 144 || input_be32(bytes.data()) != bytes.size() - 4 ||
        bytes[13] || bytes[14] || bytes[15]) return {};
    const auto epoch = input_be32(bytes.data() + 8);
    if (!epoch) return {};
    const auto op = static_cast<input_op>(bytes[12]);
    if (op == input_op::data) {
      if (bytes.size() < 24 || input_be32(bytes.data() + 16) != bytes.size() - 20) return {};
    } else if ((op != input_op::pause && op != input_op::resume) || bytes.size() != 16) return {};
    return {op, epoch};
  }

  struct input_snapshot {
    std::uint32_t epoch = 0, acknowledged = 0;
    bool enabled = false, paused = false, pending = false, closed = false, failed = false;
  };
  // A display request owns this until its first real encoded frame or failure.
  // Atomic invalidation lets capture code check it without acquiring input locks.
  struct input_selection { std::atomic<bool> valid {true}; };
  class input_epoch {
  public:
    // Called by the control thread. It immediately closes admission. Only the
    // serialized input worker may acknowledge after releasing platform state.
    bool begin(std::uint32_t epoch, bool pause) {
      std::lock_guard lock(mutex_);
      if (state_.closed || state_.failed || state_.pending || state_.epoch == UINT32_MAX || epoch != state_.epoch + 1 ||
          (!state_.enabled && !pause) || (state_.enabled && state_.paused == pause)) return false;
      if (auto selection = selection_.lock(); selection && selection->valid.load()) return false;
      state_.enabled = true; state_.epoch = epoch; state_.paused = pause; state_.pending = true;
      return true;
    }
    bool pending(std::uint32_t epoch) const {
      std::lock_guard lock(mutex_);
      return state_.pending && state_.epoch == epoch && !state_.closed && !state_.failed;
    }
    void acknowledge(std::uint32_t epoch, bool released) {
      std::lock_guard lock(mutex_);
      if (!state_.pending || state_.epoch != epoch || state_.closed || state_.failed) return;
      state_.pending = false;
      if (released) state_.acknowledged = epoch;
      else state_.failed = true;
    }
    bool permits(std::uint32_t epoch) const {
      std::lock_guard lock(mutex_);
      return !state_.closed && !state_.failed && !state_.pending &&
        ((!state_.enabled && epoch == 0) || (state_.enabled && !state_.paused && epoch == state_.acknowledged));
    }
    template<class Action>
    std::string select(std::uint32_t epoch, Action action) {
      std::lock_guard lock(mutex_);
      if (!epoch || !(epoch & 1) || !state_.enabled || !state_.paused || state_.pending || state_.closed || state_.failed ||
          state_.epoch != epoch || state_.acknowledged != epoch) return "input_not_paused";
      if (auto selection = selection_.lock(); selection && selection->valid.load()) return "input_busy";
      auto selection = std::make_shared<input_selection>();
      selection_ = selection;
      const auto result = action(selection);
      if (result != "accepted") selection->valid.store(false);
      return result;
    }
    void invalidate_selection() {
      std::lock_guard lock(mutex_);
      if (auto selection = selection_.lock()) selection->valid.store(false);
    }
    void close() {
      std::lock_guard lock(mutex_); state_.closed = true; state_.pending = false;
      if (auto selection = selection_.lock()) selection->valid.store(false);
    }
    input_snapshot snapshot() const { std::lock_guard lock(mutex_); return state_; }
  private:
    mutable std::mutex mutex_;
    input_snapshot state_;
    std::weak_ptr<input_selection> selection_;
  };

  struct input_stream {
    std::uint64_t id;
    std::string owner;
    std::shared_ptr<input_epoch> gate;
  };
  class input_registry {
  public:
    void add(void *key, std::uint64_t id, const std::string &owner, const std::shared_ptr<input_epoch> &gate) {
      if (!key || !id || owner.size() != 64 || !gate) return;
      std::lock_guard lock(mutex_);
      if (streams_.contains(key)) streams_.at(key).gate->close();
      // A newly registered stream invalidates any exclusive display operation.
      for (const auto &[existing_key, stream] : streams_) stream.gate->invalidate_selection();
      streams_.insert_or_assign(key, input_stream{id, owner, gate});
    }
    void remove(void *key) {
      std::lock_guard lock(mutex_);
      const auto found = streams_.find(key);
      if (found == streams_.end()) return;
      found->second.gate->close(); streams_.erase(found);
    }
    // The pinned input backend shares key/mouse state. Do not release another
    // controller's held input. This check runs on the serialized input worker.
    bool exclusive(const std::shared_ptr<input_epoch> &gate) const {
      std::lock_guard lock(mutex_);
      return streams_.size() == 1 && streams_.begin()->second.gate == gate;
    }
    template<class Action>
    std::string select(std::uint64_t id, std::uint32_t epoch, Action action) const {
      // Lock order: registry -> input gate -> display control. Capture code only
      // reads the atomic selection token; it never takes these input locks.
      std::lock_guard lock(mutex_);
      if (streams_.size() != 1 || streams_.begin()->second.id != id) return "input_not_exclusive";
      return streams_.begin()->second.gate->select(epoch, action);
    }
    std::vector<input_stream> snapshot() const {
      std::lock_guard lock(mutex_);
      std::vector<input_stream> result;
      for (const auto &[key, stream] : streams_) result.push_back(stream);
      return result;
    }
  private:
    mutable std::mutex mutex_;
    std::map<void *, input_stream> streams_;
  };
  inline input_registry inputs;
}
