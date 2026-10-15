// SPDX-License-Identifier: GPL-3.0-or-later
#include "../portmap.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    const uint16_t bases[] = {1029, 32000, 65514};
    const int offsets[] = {2, 9, 10, 11};
    int checked = 0;
    for (unsigned i = 0; i < sizeof(bases)/sizeof(bases[0]); i++) {
        for (unsigned j = 0; j < sizeof(bases)/sizeof(bases[0]); j++) {
            for (unsigned k = 0; k < sizeof(offsets)/sizeof(offsets[0]); k++) {
                uint16_t port = (uint16_t)(bases[j] + offsets[k]);
                assert(ClipRelayRouteValid(bases[i], bases[j], "127.0.0.1"));
                assert(ClipRelayMapPort(bases[i], bases[j], offsets[k], &port));
                assert(port == bases[i] + offsets[k]);
                checked++;
            }
        }
    }
    uint16_t port = 48798;
    assert(ClipRelayMapPort(0, 0, 9, &port) && port == 48798);
    assert(!ClipRelayMapPort(32000, 48789, 10, &port) && port == 48798);
    assert(!ClipRelayMapPort(32000, 48789, 9, NULL));
    assert(!ClipRelayMapPort(32000, 48789, 1, &port));
    assert(!ClipRelayMapPort(0, 48789, 9, &port));
    assert(!ClipRelayRouteValid(32000, 48789, "localhost"));
    assert(!ClipRelayRouteValid(32000, 48789, "127.0.0.2"));
    assert(!ClipRelayRouteValid(32000, 48789, "192.168.1.1"));
    assert(!ClipRelayRouteValid(1028, 48789, "127.0.0.1"));
    assert(!ClipRelayRouteValid(65515, 48789, "127.0.0.1"));
    assert(!ClipRelayRouteValid(32000, 65515, "127.0.0.1"));
    assert(!ClipRelayRouteValid(32000, 48789, NULL));
    printf("%d port mappings and direct/invalid-route checks passed\n", checked);
    return 0;
}
