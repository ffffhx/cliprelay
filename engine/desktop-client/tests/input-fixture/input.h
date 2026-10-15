// Minimal UI boundary for compiling the unmodified production inputepoch.cpp.
// SDL itself, the epoch policy, timer queue and adapter implementation are real.
#pragma once
#include <SDL.h>
#include <QElapsedTimer>
#include <QSet>
#include "inputstate.h"
#define MAX_GAMEPADS 16
#define MAX_FINGERS 2
struct GamepadState {
    SDL_GameController* controller = nullptr;
    SDL_JoystickID jsId = 0;
    short index = 0;
    SDL_TimerID mouseEmulationTimer = 0;
    uint32_t lastStartDownTime = 0;
    bool emulatedClickpadButtonDown = false;
    int buttons = 0;
    short lsX=0,lsY=0,rsX=0,rsY=0;
    unsigned char lt=0,rt=0;
    float lastGyroEventData[3]{},lastAccelEventData[3]{};
    uint32_t lastGyroEventTime=0,lastAccelEventTime=0;
    uint8_t cliprelayType=0;
    uint32_t cliprelayButtons=0,cliprelayCapabilities=0;
};
class SdlInputHandler {
public:
    SdlInputHandler() { m_InputClock.start(); }
    bool inputEpochsEnabled() const;
    SDL_TimerID addInputTimer(Uint32, SDL_TimerCallback, void*);
    void removeInputTimer(SDL_TimerID);
    void resetInputEpochState();
    bool processInputEpochCommands();
    bool acceptInputEpochEvent(SDL_Event&);
    void sendGamepadState(GamepadState*);
    bool m_InputEpochs=true;
    Uint32 m_InputSince=0;
    QElapsedTimer m_InputClock;
    ClipRelayInput::State m_InputState;
    ClipRelayInput::Timers m_InputTimers;
    QSet<uint32_t> m_KeysDown;
    SDL_TimerID m_LongPressTimer=0,m_LeftButtonReleaseTimer=0,m_RightButtonReleaseTimer=0,m_DragTimer=0;
    char m_DragButton=0;
    int m_NumFingersDown=0;
    SDL_TouchFingerEvent m_TouchDownEvent[MAX_FINGERS]{},m_LastTouchDownEvent{},m_LastTouchUpEvent{};
    bool m_PendingMouseButtonsAllUpOnVideoRegionLeave=false,m_NeedsManualCaptureOnLeave=false,m_MouseWasInVideoRegion=false;
    GamepadState m_GamepadState[MAX_GAMEPADS]{};
    int m_GamepadMask=1;
};
