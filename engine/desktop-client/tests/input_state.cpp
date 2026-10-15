// SPDX-License-Identifier: GPL-3.0-or-later
#include <cassert>
#include <iostream>
#include <array>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <set>
#include <tuple>
// Windows headers may define this macro before the input header is included.
#define max(a,b) windows_max_macro_must_not_expand(a,b)
#include "../inputstate.h"
#undef max
#ifdef NDEBUG
#error Input policy tests require assertions
#endif
using namespace ClipRelayInput;
int main() {
    const Control ctrl{Key,0,224,0}, a{Key,0,4,0};
    {
        State state;
        assert(!state.button(ctrl,true)); // held at startup
        state.open();
        assert(!state.button(ctrl,true,true));
        assert(state.blocked(ctrl)); // caller masks the held modifier
        assert(state.button(a,true));
        assert(!state.button(ctrl,false));
        assert(state.button(ctrl,true));
        state.close();
        state.open();
        assert(!state.button(a,true,true));
        assert(!state.button(a,false));
        assert(state.button(a,true));
        assert(state.button(a,false));
        assert(!state.button(a,false)); // unmatched UP cannot create an action
    }
    {
        State state; state.open();
        Control mouse{Mouse,0,5,0}, button{Button,12,5,0};
        assert(state.button(mouse,true)); assert(state.button(button,true));
        state.close();
        assert(!state.button(mouse,false));
        state.open();
        assert(state.button(mouse,true));
        assert(!state.button(button,true)); // other device still held
        state.forget(Button,12);
        assert(state.button(button,true));
    }
    {
        State state;
        Control axis{Axis,14,0,0};
        assert(!state.axis(axis,false));
        state.open();
        assert(!state.axis(axis,false));
        assert(!state.axis(axis,true));
        assert(state.axis(axis,false));
        state.close();
        assert(!state.axis(axis,false));
        state.forget(Axis,14); state.open();
        assert(state.axis(axis,false));
    }
    {
        State state; state.open();
        Control first{ControllerTouch,1,0,0}, second{ControllerTouch,1,1,0};
        assert(!state.held(first));
        assert(state.button(first,true));
        assert(!state.held(second));
        state.close(); state.open();
        assert(!state.held(first)); // MOVE cannot revive a cancelled contact
        assert(state.button(second,true));
        assert(!state.button(first,false));
        assert(state.button(first,true));
        assert(state.held(first));
    }
    {
        State state;
        for (int i=0;i<2048;++i) state.block({Touch,1,i,0});
        assert(state.healthy());
        state.block({Touch,1,2048,0});
        state.open(); assert(!state.healthy()); assert(!state.active());
        assert(!state.button(a,true));
    }
    {
        Timers timers; int clicks=0;
        assert(!timers.add(0,100,[&](uint32_t){++clicks;return 0;}));
        timers.open();
        int old=timers.add(0,100,[&](uint32_t){++clicks;return 0;});
        assert(old); timers.close(); timers.open();
        int fresh=timers.add(0,200,[&](uint32_t){++clicks;return 0;});
        assert(fresh!=old); assert(!timers.remove(old));
        timers.tick(150); assert(clicks==0);
        timers.tick(200); assert(clicks==1);
        timers.tick(300); assert(clicks==1);
    }
    {
        Timers timers; timers.open(); int repeats=0,late=0;
        int id=0;
        id=timers.add(0,50,[&](uint32_t delay){
            assert(delay==50); ++repeats;
            if (repeats==2) timers.remove(id);
            return 50;
        });
        timers.tick(49); assert(!repeats);
        timers.tick(50); assert(repeats==1);
        timers.tick(100); timers.tick(200); assert(repeats==2);
        timers.add(200,10,[&](uint32_t){timers.close();timers.open();return 10;});
        timers.add(200,10,[&](uint32_t){++late;return 0;});
        timers.tick(210);timers.tick(220);assert(!late);
    }
    {
        Timers timers; timers.open(); int ran=0;
        const uint64_t start=0xffffffffULL-10;
        for(int i=0;i<64;++i) assert(timers.add(start,50,[&](uint32_t){++ran;return 0;}));
        assert(!timers.add(start,50,[](uint32_t){return 0;}));
        timers.tick(start+49); assert(ran==0);
        timers.tick(start+50); assert(ran==64);
    }
    std::cout << "8 input state and timer scenarios passed\n";
}
