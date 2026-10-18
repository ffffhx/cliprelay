// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef CLIPRELAY_PORTMAP_H
#define CLIPRELAY_PORTMAP_H
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

// Zero/zero preserves direct connections. An embedded route is always literal
// loopback and maps only the advertised host's RTSP/video/control/audio ports.
static inline bool ClipRelayRouteValid(uint16_t localBase, uint16_t hostBase, const char* address) {
    if (localBase == 0 && hostBase == 0) return true;
    return localBase >= 1029 && localBase <= 65514 && hostBase >= 1029 && hostBase <= 65514 &&
           address != NULL && strcmp(address, "127.0.0.1") == 0;
}

static inline bool ClipRelayMapPort(uint16_t localBase, uint16_t hostBase, int offset, uint16_t* port) {
    if (localBase == 0 && hostBase == 0) return true;
    if (!ClipRelayRouteValid(localBase, hostBase, "127.0.0.1") || port == NULL ||
        (offset != 21 && offset != 9 && offset != 10 && offset != 11) ||
        *port != (uint16_t)(hostBase + offset)) return false;
    *port = (uint16_t)(localBase + offset);
    return true;
}
#endif
