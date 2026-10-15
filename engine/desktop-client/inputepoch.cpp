// SPDX-License-Identifier: GPL-3.0-or-later
#include "input.h"
#include "backend/sessionimport.h"
#include "streaming/session.h"
#include <Limelight.h>
#include <cmath>

using namespace ClipRelayInput;

bool SdlInputHandler::inputEpochsEnabled() const { return m_InputEpochs; }

SDL_TimerID SdlInputHandler::addInputTimer(Uint32 interval, SDL_TimerCallback callback, void* param)
{
    if (!m_InputEpochs) return SDL_AddTimer(interval, callback, param);
    return m_InputTimers.add(m_InputClock.elapsed(), interval,
                            [callback,param](uint32_t delay) { return callback(delay,param); });
}
void SdlInputHandler::removeInputTimer(SDL_TimerID id)
{
    if (!m_InputEpochs) SDL_RemoveTimer(id);
    else m_InputTimers.remove(id);
}

static bool neutralAxis(int axis, Sint16 value)
{
    return axis >= SDL_CONTROLLER_AXIS_TRIGGERLEFT ? value <= 2000 : std::abs(int(value)) <= 4096;
}

void SdlInputHandler::resetInputEpochState()
{
    m_InputTimers.close();
    m_InputState.close();
    m_KeysDown.clear();
    m_LongPressTimer = m_LeftButtonReleaseTimer = m_RightButtonReleaseTimer = m_DragTimer = 0;
    m_DragButton = 0;
    m_NumFingersDown = 0;
    SDL_zero(m_TouchDownEvent);
    SDL_zero(m_LastTouchDownEvent);
    SDL_zero(m_LastTouchUpEvent);
    if (m_PendingMouseButtonsAllUpOnVideoRegionLeave && m_NeedsManualCaptureOnLeave) SDL_CaptureMouse(SDL_FALSE);
    m_PendingMouseButtonsAllUpOnVideoRegionLeave = false;
    m_MouseWasInVideoRegion = false;

    // Pump before snapshotting: keys/buttons held through the transition must
    // reach neutral before they can begin a new remote action.
    SDL_PumpEvents();
    int count = 0;
    const auto* keys = SDL_GetKeyboardState(&count);
    for (int i = 0; i < count; ++i) m_InputState.button({Key,0,i,0}, keys[i] != 0);
    const Uint32 buttons = SDL_GetMouseState(nullptr,nullptr);
    for (int i = 1; i <= 5; ++i) m_InputState.button({Mouse,0,i,0}, (buttons & SDL_BUTTON(i)) != 0);
    for (auto& state : m_GamepadState) {
        if (state.mouseEmulationTimer) Session::get()->notifyMouseEmulationMode(false);
        state.mouseEmulationTimer = 0;
        state.lastStartDownTime = 0;
        state.emulatedClickpadButtonDown = false;
        state.buttons = state.lsX = state.lsY = state.rsX = state.rsY = state.lt = state.rt = 0;
#if SDL_VERSION_ATLEAST(2, 0, 14)
        SDL_zero(state.lastGyroEventData); SDL_zero(state.lastAccelEventData);
        state.lastGyroEventTime = state.lastAccelEventTime = 0;
#endif
        if (!state.controller) continue;
        for (int button = 0; button < SDL_CONTROLLER_BUTTON_MAX; ++button)
            m_InputState.button({Button,state.jsId,button,0}, SDL_GameControllerGetButton(state.controller,SDL_GameControllerButton(button)) != 0);
        for (int axis = 0; axis < SDL_CONTROLLER_AXIS_MAX; ++axis)
            m_InputState.axis({Axis,state.jsId,axis,0}, neutralAxis(axis,SDL_GameControllerGetAxis(state.controller,SDL_GameControllerAxis(axis))));
#if SDL_VERSION_ATLEAST(2, 0, 14)
        for (int pad = 0; pad < SDL_GameControllerGetNumTouchpads(state.controller); ++pad)
            for (int finger = 0; finger < SDL_GameControllerGetNumTouchpadFingers(state.controller,pad); ++finger) {
                Uint8 down = 0; float x = 0, y = 0, pressure = 0;
                if (SDL_GameControllerGetTouchpadFinger(state.controller,pad,finger,&down,&x,&y,&pressure) == 0)
                    m_InputState.button({ControllerTouch,state.jsId,pad,finger}, down != 0);
            }
#endif
    }
    for (int device = 0; device < SDL_GetNumTouchDevices(); ++device) {
        const SDL_TouchID id = SDL_GetTouchDevice(device);
        for (int i = 0; i < SDL_GetNumTouchFingers(id); ++i) {
            const SDL_Finger* finger = SDL_GetTouchFinger(id,i);
            if (finger) m_InputState.block({Touch,id,finger->id,0});
        }
    }
    // Leave device, quit, window and decoder events in the queue.
    const Uint32 types[] = {SDL_KEYDOWN,SDL_KEYUP,SDL_TEXTINPUT,SDL_TEXTEDITING,
        SDL_MOUSEMOTION,SDL_MOUSEBUTTONDOWN,SDL_MOUSEBUTTONUP,SDL_MOUSEWHEEL,
        SDL_CONTROLLERAXISMOTION,SDL_CONTROLLERBUTTONDOWN,SDL_CONTROLLERBUTTONUP,
        SDL_FINGERDOWN,SDL_FINGERUP,SDL_FINGERMOTION,
#if SDL_VERSION_ATLEAST(2, 0, 14)
        SDL_CONTROLLERSENSORUPDATE,SDL_CONTROLLERTOUCHPADDOWN,SDL_CONTROLLERTOUCHPADUP,SDL_CONTROLLERTOUCHPADMOTION,
#endif
    };
    for (Uint32 type : types) SDL_FlushEvent(type);
    m_InputSince = SDL_GetTicks();
}

bool SdlInputHandler::processInputEpochCommands()
{
    if (!m_InputEpochs) return true;
    ClipRelayImport::InputCommand command;
    while (ClipRelayImport::takeInputCommand(command)) {
        const bool ack = command.operation == ClipRelayImport::InputOperation::Acknowledge;
        if (ack) {
            // The owner sends ACK only after verifying the host's paired input
            // state. Local cleanup must precede reopening native admission.
            if (!(command.epoch & 1)) resetInputEpochState();
            if (LiClipRelayInputAcknowledge(command.epoch) != 0) return false;
            if (!(command.epoch & 1)) {
                if (!m_InputState.healthy()) return false;
                m_InputState.open();
                m_InputTimers.open();
                // Arrival/removal may have happened while admission was closed.
                for (auto& state : m_GamepadState) {
                    if (state.controller) {
#if SDL_VERSION_ATLEAST(2, 0, 14)
                        if (LiSendControllerArrivalEvent(state.index,m_GamepadMask,state.cliprelayType,
                                state.cliprelayButtons,state.cliprelayCapabilities) != 0) return false;
#endif
                        sendGamepadState(&state);
                    }
                }
                for (int slot = 0; slot < MAX_GAMEPADS; ++slot)
                    if (!(m_GamepadMask & (1 << slot)) && LiSendMultiControllerEvent(slot,m_GamepadMask,0,0,0,0,0,0,0) != 0) return false;
            }
        } else {
            const bool pause = command.operation == ClipRelayImport::InputOperation::Pause;
            if (LiClipRelayInputCommand(command.epoch,pause) != 0) return false;
            resetInputEpochState();
        }
        if (!m_InputState.healthy()) return false;
        ClipRelayImport::reportInputCommand(command.epoch,ack);
    }
    m_InputTimers.tick(m_InputClock.elapsed());
    return m_InputState.healthy();
}

bool SdlInputHandler::acceptInputEpochEvent(SDL_Event& event)
{
    if (!m_InputEpochs) return true;
    const bool fresh = Sint32(event.common.timestamp - m_InputSince) > 0;
    auto button = [&](const Control& key, bool down, bool repeat = false) {
        if (!fresh) {
            if (down && !m_InputState.held(key)) m_InputState.block(key);
            return false;
        }
        return m_InputState.button(key,down,repeat);
    };
    switch (event.type) {
    case SDL_KEYDOWN: case SDL_KEYUP: {
        if (!button({Key,0,event.key.keysym.scancode,0},event.type==SDL_KEYDOWN,event.key.repeat != 0)) return false;
        const std::pair<SDL_Scancode,Uint16> modifiers[] = {
            {SDL_SCANCODE_LCTRL,KMOD_LCTRL},{SDL_SCANCODE_RCTRL,KMOD_RCTRL},
            {SDL_SCANCODE_LSHIFT,KMOD_LSHIFT},{SDL_SCANCODE_RSHIFT,KMOD_RSHIFT},
            {SDL_SCANCODE_LALT,KMOD_LALT},{SDL_SCANCODE_RALT,KMOD_RALT},
            {SDL_SCANCODE_LGUI,KMOD_LGUI},{SDL_SCANCODE_RGUI,KMOD_RGUI}};
        for (const auto& modifier : modifiers)
            if (m_InputState.blocked({Key,0,modifier.first,0})) event.key.keysym.mod &= ~modifier.second;
        return true;
    }
    case SDL_MOUSEBUTTONDOWN: case SDL_MOUSEBUTTONUP:
        // SDL duplicates touch as mouse input. The normal mouse handler ignores
        // it; do so before it can consume a physical mouse's tracked UP.
        if (event.button.which == SDL_TOUCH_MOUSEID) return false;
        return button({Mouse,0,event.button.button,0},event.type==SDL_MOUSEBUTTONDOWN);
    case SDL_CONTROLLERBUTTONDOWN: case SDL_CONTROLLERBUTTONUP:
        return button({Button,event.cbutton.which,event.cbutton.button,0},event.type==SDL_CONTROLLERBUTTONDOWN);
    case SDL_CONTROLLERAXISMOTION:
        return fresh && m_InputState.axis({Axis,event.caxis.which,event.caxis.axis,0},neutralAxis(event.caxis.axis,event.caxis.value));
    case SDL_FINGERDOWN: case SDL_FINGERUP:
        return button({Touch,event.tfinger.touchId,event.tfinger.fingerId,0},event.type==SDL_FINGERDOWN);
    case SDL_FINGERMOTION:
        return fresh && m_InputState.held({Touch,event.tfinger.touchId,event.tfinger.fingerId,0});
#if SDL_VERSION_ATLEAST(2, 0, 14)
    case SDL_CONTROLLERTOUCHPADDOWN: case SDL_CONTROLLERTOUCHPADUP:
        return button({ControllerTouch,event.ctouchpad.which,event.ctouchpad.touchpad,event.ctouchpad.finger},event.type==SDL_CONTROLLERTOUCHPADDOWN);
    case SDL_CONTROLLERTOUCHPADMOTION:
        return fresh && m_InputState.held({ControllerTouch,event.ctouchpad.which,event.ctouchpad.touchpad,event.ctouchpad.finger});
    case SDL_CONTROLLERSENSORUPDATE:
#endif
    case SDL_MOUSEMOTION: case SDL_MOUSEWHEEL: case SDL_TEXTINPUT: case SDL_TEXTEDITING:
        return fresh && m_InputState.active();
    case SDL_CONTROLLERDEVICEREMOVED:
        for (int kind : {Button,Axis,ControllerTouch}) m_InputState.forget(kind,event.cdevice.which);
        return true;
    default:
        return true;
    }
}
