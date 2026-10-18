// SPDX-License-Identifier: GPL-3.0-only
/**
 * @file cliprelay_macos.h
 * @brief Logical capture geometry and native pointer routing for the Mac host.
 */
#pragma once

#include "cliprelay_control.h"

#include <cmath>
#include <libvirtualhid/types.hpp>
#include <limits>

namespace cliprelay::macos {
  /** @brief Display bounds in CoreGraphics logical desktop coordinates. */
  struct rectangle {
    double x, y, width, height;  ///< Origin and extent in logical points.
  };

  /**
   * @brief Validate logical bounds without truncating fractional or invalid values.
   * @param value The selected screen or active-desktop bounds.
   * @return Whether all coordinates and extents are representable by the protocol.
   */
  inline bool valid(const rectangle &value) {
    for (const auto number : {value.x, value.y, value.width, value.height}) {
      if (!std::isfinite(number) || std::trunc(number) != number || number < std::numeric_limits<int>::min() || number > std::numeric_limits<int>::max()) {
        return false;
      }
    }
    return value.width > 0 && value.height > 0 &&
           value.x + value.width <= std::numeric_limits<int>::max() &&
           value.y + value.height <= std::numeric_limits<int>::max();
  }

  /**
   * @brief Build native geometry without mixing Retina pixels with logical points.
   * @param id Actual capture display ID.
   * @param selected Logical rectangle of the captured display.
   * @param desktop Union of active display rectangles in the same coordinate space.
   * @return Validated geometry, or no geometry when capture cannot be represented.
   */
  inline std::optional<display_geometry> geometry(std::string id, rectangle selected, rectangle desktop) {
    if (id.empty() || !valid(selected) || !valid(desktop) || selected.x < desktop.x || selected.y < desktop.y || selected.x + selected.width > desktop.x + desktop.width || selected.y + selected.height > desktop.y + desktop.height) {
      return std::nullopt;
    }
    return display_geometry {std::move(id), static_cast<int>(selected.x), static_cast<int>(selected.y), static_cast<int>(selected.width), static_cast<int>(selected.height), static_cast<int>(desktop.x), static_cast<int>(desktop.y), static_cast<int>(desktop.width), static_cast<int>(desktop.height)};
  }

  /**
   * @brief Bind an event to an actual, encoded capture and its cancellation barrier.
   * @param state Atomic capture registry snapshot owned by the host.
   * @return Target version ordered as preparing, active, then stopped per capture.
   *
   * Preparing must not cancel the generation which will become active after its
   * first encoded frame. Switching or invalidating an already encoded capture
   * closes that generation permanently. A new capture always has a larger version.
   */
  inline lvh::PointerTarget pointer_target(const display_snapshot &state) {
    lvh::PointerTarget result;
    if (state.generation > (std::numeric_limits<std::uint64_t>::max() - 3) / 3) {
      result.generation = std::numeric_limits<std::uint64_t>::max();
      return result;
    }
    bool encoded = false;
    for (const auto &stream : state.streams) {
      encoded |= stream.generation == state.generation && stream.first_frame > 0;
    }
    result.active = state.capture && encoded && state.phase == "active";
    const auto phase = result.active ? 1U : (state.capture && !encoded ? 0U : 2U);
    result.generation = state.generation * 3 + phase + 1;
    if (result.active) {
      const auto &g = *state.capture;
      result.viewport = {g.x, g.y, g.width, g.height};
    }
    return result;
  }
}  // namespace cliprelay::macos
