// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <set>
#include <tuple>

namespace ClipRelayInput {
// Device identity is separate from button/contact identity. Touchpad contacts
// also include their pad number. All methods run on the SDL event thread.
using Control = std::tuple<int, int64_t, int64_t, int64_t>;
enum Kind { Key, Mouse, Button, Axis, Touch, ControllerTouch };
class State {
public:
    void close() {
        active_ = false;
        for (const auto& key : down_) block(key);
        down_.clear();
    }
    void open() { active_ = healthy_; }
    bool active() const { return active_ && healthy_; }
    bool healthy() const { return healthy_; }
    void block(const Control& key) {
        if (blocked_.size() >= 2048 && !blocked_.count(key)) { healthy_ = false; return; }
        blocked_.insert(key);
    }
    bool blocked(const Control& key) const { return blocked_.count(key); }
    bool held(const Control& key) const { return active() && down_.count(key); }
    bool button(const Control& key, bool down, bool repeat = false) {
        if (!down) {
            if (blocked_.erase(key)) { down_.erase(key); return false; }
            return down_.erase(key) != 0 && active();
        }
        if (!active()) { block(key); return false; }
        if (blocked(key)) return false;
        if (repeat) return held(key);
        if (held(key)) return false;
        if (down_.size() >= 2048 && !down_.count(key)) { healthy_ = false; return false; }
        down_.insert(key);
        return true;
    }
    bool axis(const Control& key, bool neutral) {
        if (!active()) { if (!neutral) block(key); else blocked_.erase(key); return false; }
        if (blocked(key)) { if (neutral) blocked_.erase(key); return false; }
        return true;
    }
    void forget(int kind, int64_t device) {
        auto remove = [=](std::set<Control>& controls) {
            for (auto it = controls.begin(); it != controls.end();) {
                if (std::get<0>(*it) == kind && std::get<1>(*it) == device) it = controls.erase(it);
                else ++it;
            }
        };
        remove(blocked_); remove(down_);
    }
private:
    bool active_ = false, healthy_ = true;
    std::set<Control> blocked_, down_;
};

// Epoch-owned timers execute on the event thread. No background callback can
// race a pause, retain a GamepadState pointer after removal, or run after resume.
class Timers {
public:
    using Callback = std::function<uint32_t(uint32_t)>;
    void close() { active_ = false; entries_.clear(); }
    void open() { active_ = true; }
    int add(uint64_t now, uint32_t interval, Callback callback) {
        if (!active_ || !interval || !callback || entries_.size() >= 64 || next_ == (std::numeric_limits<int>::max)()) return 0;
        const int id = ++next_;
        entries_.emplace(id, Entry{now + interval, interval, std::move(callback)});
        return id;
    }
    bool remove(int id) { return entries_.erase(id) != 0; }
    void tick(uint64_t now) {
        std::array<int,64> due{};
        size_t count = 0;
        for (const auto& entry : entries_) if (entry.second.at <= now) due[count++] = entry.first;
        for (size_t i = 0; i < count && active_; ++i) {
            auto found = entries_.find(due[i]);
            if (found == entries_.end()) continue;
            // A callback may remove itself or clear the queue; copy it first.
            const Entry entry = found->second;
            const uint32_t next = entry.callback(entry.interval);
            found = entries_.find(due[i]);
            if (found == entries_.end()) continue;
            if (!next) entries_.erase(found);
            else { found->second.interval = next; found->second.at = now + next; }
        }
    }
private:
    struct Entry { uint64_t at; uint32_t interval; Callback callback; };
    bool active_ = false;
    int next_ = 0;
    std::map<int,Entry> entries_;
};
}
