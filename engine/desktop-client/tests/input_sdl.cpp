// Test production adapter with real SDL dummy video and a virtual controller.
#include "input-fixture/input.h"
#include "../sessionimport.h"
#include <Limelight.h>
#include <QCoreApplication>
#include <cassert>
#include <deque>
#include <iostream>
#include <vector>
#ifdef NDEBUG
#error SDL input tests require assertions
#endif
static std::deque<ClipRelayImport::InputCommand> commands;
static std::vector<std::pair<uint32_t,bool>> reports;
static uint32_t epoch=0,pending=0;
static bool admitted=false;
static int gamepadPackets=0;
bool ClipRelayImport::takeInputCommand(InputCommand& command) {
    if(commands.empty()) return false;
    command=commands.front(); commands.pop_front(); return true;
}
void ClipRelayImport::reportInputCommand(quint32 e,bool ack) { reports.emplace_back(e,ack); }
int LiClipRelayInputCommand(uint32_t next,bool pause) {
    if(pending||next!=epoch+1||pause!=bool(next&1))return -2;
    admitted=false;epoch=pending=next;return 0;
}
int LiClipRelayInputAcknowledge(uint32_t next) {
    if(!pending||next!=pending)return -2;
    pending=0;admitted=!(next&1);return 0;
}
int LiSendControllerArrivalEvent(uint8_t,uint16_t,uint8_t,uint32_t,uint16_t) { assert(admitted);return 0; }
int LiSendMultiControllerEvent(short,short,int,unsigned char,unsigned char,short,short,short,short) {
    assert(admitted);++gamepadPackets;return 0;
}
void SdlInputHandler::sendGamepadState(GamepadState* state) {
    assert(admitted);assert(!state->buttons&&!state->lt&&!state->rt&&!state->lsX&&!state->lsY&&!state->rsX&&!state->rsY);
    ++gamepadPackets;
}
static void command(SdlInputHandler& handler,uint32_t e,ClipRelayImport::InputOperation op) {
    commands.push_back({e,op});assert(handler.processInputEpochCommands());
}
static SDL_Event key(SdlInputHandler& handler,Uint32 type,SDL_Scancode code,Uint16 mods=0) {
    SDL_Event event{};event.type=type;event.key.timestamp=handler.m_InputSince+10;
    event.key.keysym.scancode=code;event.key.keysym.mod=mods;return event;
}
int main(int argc,char** argv) {
    QCoreApplication app(argc,argv);
    SDL_SetHint(SDL_HINT_VIDEODRIVER,"dummy");
    SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS,"1");
    assert(SDL_Init(SDL_INIT_VIDEO|SDL_INIT_GAMECONTROLLER|SDL_INIT_TIMER)==0);
    using Op=ClipRelayImport::InputOperation;
    using namespace ClipRelayInput;
    {
        SdlInputHandler handler;
        SDL_Event quit{};quit.type=SDL_QUIT;assert(SDL_PushEvent(&quit)==1);
        auto stale=key(handler,SDL_KEYDOWN,SDL_SCANCODE_A);assert(SDL_PushEvent(&stale)==1);
        command(handler,1,Op::Pause);
        assert(!admitted&&!handler.m_InputState.active());
        SDL_Event event{};assert(SDL_PeepEvents(&event,1,SDL_GETEVENT,SDL_QUIT,SDL_QUIT)==1);
        assert(SDL_PeepEvents(&event,1,SDL_GETEVENT,SDL_KEYDOWN,SDL_KEYDOWN)==0);
        command(handler,1,Op::Acknowledge);
        command(handler,2,Op::Resume);
        assert(!handler.m_InputState.active());
        command(handler,2,Op::Acknowledge);
        assert(admitted&&handler.m_InputState.active());

        // Modifier masks and stale timestamps are enforced in the real adapter.
        handler.m_InputState.block({Key,0,SDL_SCANCODE_LCTRL,0});
        event=key(handler,SDL_KEYDOWN,SDL_SCANCODE_A,KMOD_LCTRL|KMOD_LSHIFT);
        assert(handler.acceptInputEpochEvent(event));
        assert(!(event.key.keysym.mod&KMOD_LCTRL));assert(event.key.keysym.mod&KMOD_LSHIFT);
        event=key(handler,SDL_KEYUP,SDL_SCANCODE_A);assert(handler.acceptInputEpochEvent(event));
        event=key(handler,SDL_KEYDOWN,SDL_SCANCODE_B);event.key.timestamp=handler.m_InputSince;
        assert(!handler.acceptInputEpochEvent(event));
        event=key(handler,SDL_KEYDOWN,SDL_SCANCODE_B);assert(!handler.acceptInputEpochEvent(event));
        event=key(handler,SDL_KEYUP,SDL_SCANCODE_B);assert(!handler.acceptInputEpochEvent(event));
        event=key(handler,SDL_KEYDOWN,SDL_SCANCODE_B);assert(handler.acceptInputEpochEvent(event));

        // Real SDL controller state held through reset cannot be reintroduced.
        const int device=SDL_JoystickAttachVirtual(SDL_JOYSTICK_TYPE_GAMECONTROLLER,SDL_CONTROLLER_AXIS_MAX,SDL_CONTROLLER_BUTTON_MAX,0);
        assert(device>=0&&SDL_IsGameController(device));
        auto& pad=handler.m_GamepadState[0];
        pad.controller=SDL_GameControllerOpen(device);assert(pad.controller);
        SDL_Joystick* joystick=SDL_GameControllerGetJoystick(pad.controller);
        pad.jsId=SDL_JoystickInstanceID(joystick);
        assert(SDL_JoystickSetVirtualButton(joystick,SDL_CONTROLLER_BUTTON_A,1)==0);
        assert(SDL_JoystickSetVirtualAxis(joystick,SDL_CONTROLLER_AXIS_LEFTX,24000)==0);
        SDL_JoystickUpdate();
        pad.buttons=1;pad.lsX=24000;pad.lastStartDownTime=123;pad.emulatedClickpadButtonDown=true;
        handler.m_KeysDown.insert(123);handler.m_NumFingersDown=2;handler.m_DragButton=1;
        int delayed=0;
        handler.m_DragTimer=handler.addInputTimer(1,[](Uint32,void* p)->Uint32{++*static_cast<int*>(p);return 0;},&delayed);
        command(handler,3,Op::Pause);
        assert(!handler.m_KeysDown.size()&&!handler.m_NumFingersDown&&!handler.m_DragButton&&!handler.m_DragTimer);
        assert(!pad.buttons&&!pad.lsX&&!pad.lastStartDownTime&&!pad.emulatedClickpadButtonDown);
        command(handler,3,Op::Acknowledge);command(handler,4,Op::Resume);command(handler,4,Op::Acknowledge);
        SDL_Delay(5);assert(handler.processInputEpochCommands());assert(!delayed);
        event={};event.type=SDL_CONTROLLERBUTTONDOWN;event.cbutton.timestamp=handler.m_InputSince+10;
        event.cbutton.which=pad.jsId;event.cbutton.button=SDL_CONTROLLER_BUTTON_A;
        assert(!handler.acceptInputEpochEvent(event));
        event.type=SDL_CONTROLLERBUTTONUP;assert(!handler.acceptInputEpochEvent(event));
        event.type=SDL_CONTROLLERBUTTONDOWN;assert(handler.acceptInputEpochEvent(event));
        event={};event.type=SDL_CONTROLLERAXISMOTION;event.caxis.timestamp=handler.m_InputSince+10;
        event.caxis.which=pad.jsId;event.caxis.axis=SDL_CONTROLLER_AXIS_LEFTX;event.caxis.value=24000;
        assert(!handler.acceptInputEpochEvent(event));event.caxis.value=0;assert(!handler.acceptInputEpochEvent(event));
        event.caxis.value=24000;assert(handler.acceptInputEpochEvent(event));

        // Stale contact movement cannot create a new touch in the new epoch.
        event={};event.type=SDL_FINGERMOTION;event.tfinger.timestamp=handler.m_InputSince+10;
        event.tfinger.touchId=7;event.tfinger.fingerId=8;assert(!handler.acceptInputEpochEvent(event));
        event.type=SDL_FINGERDOWN;assert(handler.acceptInputEpochEvent(event));
        event.type=SDL_FINGERMOTION;assert(handler.acceptInputEpochEvent(event));
        command(handler,5,Op::Pause);command(handler,5,Op::Acknowledge);
        command(handler,6,Op::Resume);command(handler,6,Op::Acknowledge);
        event.tfinger.timestamp=handler.m_InputSince+10;assert(!handler.acceptInputEpochEvent(event));
        event.type=SDL_FINGERUP;assert(!handler.acceptInputEpochEvent(event));
        event.type=SDL_FINGERDOWN;assert(handler.acceptInputEpochEvent(event));
        assert(reports.size()==12&&gamepadPackets>0);
        commands.push_back({4,Op::Acknowledge});assert(!handler.processInputEpochCommands());
        SDL_GameControllerClose(pad.controller);pad.controller=nullptr;
        assert(SDL_JoystickDetachVirtual(device)==0);
    }
    SDL_Quit();
    std::cout << "5 production SDL adapter scenarios passed\n";
}
