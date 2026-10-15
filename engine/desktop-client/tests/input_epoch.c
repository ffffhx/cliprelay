// SPDX-License-Identifier: GPL-3.0-or-later
// Compile against the patched pinned common source. Real input producers,
// queue, batcher, sender and platform mutexes; transport is an in-memory sink.
#include "Limelight-internal.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#ifdef NDEBUG
#error The input queue fixture requires LC_DEBUG and active assertions.
#endif

static void fixtureLockMutex(PLT_MUTEX* mutex);
static void fixtureSleep(int ms);
static uint64_t fixtureMillis(void);
#define PltLockMutex fixtureLockMutex
#define PltSleepMs fixtureSleep
#define PltGetMillis fixtureMillis
#include "InputStream.c"
#undef PltLockMutex
#undef PltSleepMs
#undef PltGetMillis

int AppVersionQuad[4] = {7,1,431,-1};
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
uint32_t SunshineFeatureFlags = LI_FF_PEN_TOUCH_EVENTS | LI_FF_CONTROLLER_TOUCH_EVENTS;
struct sockaddr_storage RemoteAddr;
SOCKADDR_LEN AddrLen;
uint16_t RtspPortNumber;
int enet_initialize(void) { assert(!"Network initialization is not part of this fixture"); return -1; }
void enet_deinitialize(void) {}
static _Thread_local bool sender;
static atomic_int freezeBatch, freezeSleep, barrierEntered, barrierReleased, transit;
static PLT_MUTEX wireMutex;
static struct { unsigned char bytes[144]; int length; uint8_t channel; uint32_t flags; } wire[512];
static int wireCount, failSend;

static void barrier(void) {
    atomic_store(&barrierEntered,1);
    while (!atomic_load(&barrierReleased)) PltSleepMs(1);
}
static void fixtureLockMutex(PLT_MUTEX* mutex) {
    if (sender && mutex == &batchedInputMutex && atomic_exchange(&freezeBatch,0)) barrier();
    PltLockMutex(mutex);
}
static void fixtureSleep(int ms) {
    if (sender && atomic_exchange(&freezeSleep,0)) barrier();
    PltSleepMs(ms);
}
static uint64_t fixtureMillis(void) { return 1; }
static void waitBarrier(void) {
    const uint64_t deadline = PltGetMillis()+2000;
    while (!atomic_load(&barrierEntered) && PltGetMillis()<deadline) PltSleepMs(1);
    assert(atomic_load(&barrierEntered));
}
static int countWire(void) {
    PltLockMutex(&wireMutex);
    const int count=wireCount;
    PltUnlockMutex(&wireMutex);
    return count;
}
static void waitWire(int count) {
    const uint64_t deadline = PltGetMillis()+2000;
    while (countWire()<count && PltGetMillis()<deadline) PltSleepMs(1);
    assert(countWire()==count);
}
static uint32_t be32(const unsigned char* bytes) {
    return ((uint32_t)bytes[0]<<24)|((uint32_t)bytes[1]<<16)|((uint32_t)bytes[2]<<8)|bytes[3];
}
static void noTermination(int error) { (void)error; assert(!"Unexpected transport failure"); }
int sendInputPacketOnControlStream(unsigned char* data,int length,uint8_t channel,uint32_t flags,bool more) {
    (void)more;
    PltLockMutex(&wireMutex);
    assert(length>0 && length<=144 && wireCount<512);
    if (failSend) { PltUnlockMutex(&wireMutex); return -77; }
    memcpy(wire[wireCount].bytes,data,length);
    wire[wireCount].length=length;
    wire[wireCount].channel=channel;
    wire[wireCount].flags=flags;
    wireCount++;
    PltUnlockMutex(&wireMutex);
    return 0;
}
void flushInputOnControlStream(void) {}
bool isControlDataInTransit(void) { return atomic_load(&transit)!=0; }
PPLT_CRYPTO_CONTEXT PltCreateCryptoContext(void) { return calloc(1,sizeof(PLT_CRYPTO_CONTEXT)); }
void PltDestroyCryptoContext(PPLT_CRYPTO_CONTEXT context) { free(context); }
bool PltEncryptMessage(PPLT_CRYPTO_CONTEXT ctx,int algorithm,int flags,unsigned char* key,int keyLength,
    unsigned char* iv,int ivLength,unsigned char* tag,int tagLength,unsigned char* input,int inputLength,
    unsigned char* output,int* outputLength) {
    (void)ctx;(void)algorithm;(void)flags;(void)key;(void)keyLength;(void)iv;(void)ivLength;
    (void)tag;(void)tagLength;(void)input;(void)inputLength;(void)output;(void)outputLength;
    assert(!"This fixture only uses encrypted control transport"); return false;
}

static void setup(bool enabled) {
    memset(&StreamConfig,0,sizeof(StreamConfig));
    StreamConfig.cliprelayInputEpochs=enabled;
    ListenerCallbacks.connectionTerminated=noTermination;
    atomic_store(&freezeBatch,0); atomic_store(&freezeSleep,0);
    atomic_store(&barrierEntered,0); atomic_store(&barrierReleased,0); atomic_store(&transit,0);
    wireCount=failSend=0;
    assert(initializeInputStream()==0);
    // The real sender is started separately so producers can fill its queue.
    initialized=true;
}
static void teardown(void) {
    initialized=false;
    LbqSignalQueueShutdown(&packetQueue);
    LbqSignalQueueShutdown(&packetHolderFreeList);
    destroyInputStream();
}
static void worker(void* context) { sender=true; inputSendThreadProc(context); sender=false; }
static void startSender(void) { assert(PltCreateThread("EpochTest",worker,NULL,&inputSendThread)==0); }
static void joinSender(void) { LbqSignalQueueDrain(&packetQueue); PltJoinThread(&inputSendThread); }
static void drain(void) { startSender(); joinSender(); }
static void activate(void) {
    assert(LiClipRelayInputCommand(1,true)==0);
    assert(LiClipRelayInputAcknowledge(1)==0);
    assert(LiClipRelayInputCommand(2,false)==0);
    assert(LiClipRelayInputAcknowledge(2)==0);
}
static void transition(void) {
    assert(LiClipRelayInputCommand(3,true)==0);
    assert(LiClipRelayInputAcknowledge(3)==0);
    assert(LiClipRelayInputCommand(4,false)==0);
    assert(LiClipRelayInputAcknowledge(4)==0);
}
static void blockedProducers(void) {
    assert(LiSendMouseMoveEvent(1,2)==-2);
    assert(LiSendMousePositionEvent(1,2,1280,720)==-2);
    assert(LiSendMouseMoveAsMousePositionEvent(1,2,1280,720)==-2);
    assert(LiSendMouseButtonEvent(BUTTON_ACTION_PRESS,BUTTON_LEFT)==-2);
    assert(LiSendKeyboardEvent2(65,KEY_ACTION_DOWN,0,0)==-2);
    assert(LiSendKeyboardEvent(65,KEY_ACTION_DOWN,0)==-2);
    assert(LiSendUtf8TextEvent("old",3)==-2);
    assert(LiSendControllerEvent(A_FLAG,255,0,1,2,3,4)==-2);
    assert(LiSendMultiControllerEvent(0,1,A_FLAG,255,0,1,2,3,4)==-2);
    assert(LiSendHighResScrollEvent(1)==-2);
    assert(LiSendScrollEvent(1)==-2);
    assert(LiSendHighResHScrollEvent(1)==-2);
    assert(LiSendHScrollEvent(1)==-2);
    assert(LiSendTouchEvent(LI_TOUCH_EVENT_DOWN,1,0,0,1,0,0,0)==-2);
    assert(LiSendPenEvent(LI_TOUCH_EVENT_DOWN,LI_TOOL_TYPE_PEN,1,0,0,1,0,0,0,0)==-2);
    assert(LiSendControllerArrivalEvent(0,1,LI_CTYPE_PS,0,LI_CCAP_TOUCHPAD)==-2);
    assert(LiSendControllerTouchEvent2(0,LI_TOUCH_EVENT_DOWN,0,1,0,0,1)==-2);
    assert(LiSendControllerTouchEvent(0,LI_TOUCH_EVENT_DOWN,1,0,0,1)==-2);
    assert(LiSendControllerMotionEvent(0,LI_MOTION_TYPE_GYRO,1,2,3)==-2);
    assert(LiSendControllerBatteryEvent(0,LI_BATTERY_STATE_CHARGING,90)==-2);
    assert(LbqGetItemCount(&packetQueue)==0);
    assert(currentPenButtonState==0 && !currentRelativeMouseState.dirty && !currentAbsoluteMouseState.dirty);
    assert(currentQueuedControllerPacket[0]==NULL && !currentGamepadSensorState[0][0].dirty);
}
static void testHandshakeAndAllProducers(void) {
    setup(true); blockedProducers();
    assert(LiClipRelayInputCommand(1,false)==-2);
    assert(LiClipRelayInputCommand(7,true)==-2);
    assert(LiClipRelayInputCommand(1,true)==0);
    blockedProducers();
    assert(LiClipRelayInputCommand(2,false)==-2);
    assert(LiClipRelayInputAcknowledge(2)==-2);
    assert(LiClipRelayInputAcknowledge(1)==0);
    assert(LiClipRelayInputCommand(2,false)==0);
    blockedProducers();
    assert(LiClipRelayInputAcknowledge(2)==0);
    assert(LiSendKeyboardEvent(65,KEY_ACTION_DOWN,0)==0);
    drain();
    assert(wireCount==3 && wire[2].bytes[12]==3 && be32(wire[2].bytes+8)==2);
    assert(wire[2].channel==CTRL_CHANNEL_KEYBOARD && wire[2].flags==ENET_PACKET_FLAG_RELIABLE);
    assert(wire[2].length==16+sizeof(NV_KEYBOARD_PACKET));
    assert(be32(wire[2].bytes)==(uint32_t)wire[2].length-4);
    teardown();
}
static void testQueuedDataAndFailures(void) {
    setup(true); activate();
    for(int i=0;i<MAX_QUEUED_INPUT_PACKETS;i++) assert(LiSendKeyboardEvent(65,KEY_ACTION_DOWN,0)==0);
    assert(LiClipRelayInputCommand(3,true)==0);
    assert(LbqGetItemCount(&packetQueue)==0);
    assert(LiClipRelayInputAcknowledge(2)==-2);
    assert(LiClipRelayInputCommand(2,false)==-2);
    assert(LiClipRelayInputAcknowledge(3)==0);
    failSend=1;
    assert(LiClipRelayInputCommand(4,false)==-77);
    assert(LiClipRelayInputAcknowledge(4)==-2);
    blockedProducers();
    failSend=0;
    drain(); assert(wireCount==3);
    teardown();
}
static void testBatchGeneration(int kind) {
    setup(true); activate();
    if(kind==0) assert(LiSendMouseMoveEvent(5,9)==0);
    if(kind==1) assert(LiSendMousePositionEvent(5,9,1280,720)==0);
    if(kind==2) assert(LiSendControllerMotionEvent(0,LI_MOTION_TYPE_GYRO,5,9,3)==0);
    if(kind==3) assert(LiSendMultiControllerEvent(0,1,A_FLAG,0,0,5,9,0,0)==0);
    atomic_store(&freezeBatch,1); startSender(); waitBarrier();
    transition();
    if(kind==0) assert(LiSendMouseMoveEvent(17,23)==0);
    if(kind==1) assert(LiSendMousePositionEvent(17,23,1280,720)==0);
    if(kind==2) assert(LiSendControllerMotionEvent(0,LI_MOTION_TYPE_GYRO,17,23,0)==0);
    if(kind==3) assert(LiSendMultiControllerEvent(0,1,B_FLAG,0,0,17,23,0,0)==0);
    atomic_store(&barrierReleased,1); waitWire(5); joinSender();
    assert(wireCount==5 && be32(wire[4].bytes+8)==4 && wire[4].bytes[12]==3);
    const unsigned char* payload=wire[4].bytes+16;
    if(kind==0) { NV_REL_MOUSE_MOVE_PACKET packet; memcpy(&packet,payload,sizeof(packet)); assert(BE16(packet.deltaX)==17 && BE16(packet.deltaY)==23); }
    if(kind==1) { NV_ABS_MOUSE_MOVE_PACKET packet; memcpy(&packet,payload,sizeof(packet)); assert(BE16(packet.x)==17 && BE16(packet.y)==23); }
    if(kind==2) { SS_CONTROLLER_MOTION_PACKET packet; netfloat expected; memcpy(&packet,payload,sizeof(packet)); floatToNetfloat(17,expected); assert(memcmp(packet.x,expected,4)==0); }
    if(kind==3) { NV_MULTI_CONTROLLER_PACKET packet; memcpy(&packet,payload,sizeof(packet)); assert(LE16(packet.buttonFlags)==B_FLAG && LE16(packet.leftStickX)==17); }
    teardown();
}
static void testFullQueueCannotRetainARecycledController(void) {
    setup(true); activate();
    for(int i=0;i<MAX_QUEUED_INPUT_PACKETS;i++) assert(LiSendKeyboardEvent(65,KEY_ACTION_DOWN,0)==0);
    assert(LiSendMultiControllerEvent(0,1,A_FLAG,0,0,1,2,3,4)==LBQ_BOUND_EXCEEDED);
    assert(currentQueuedControllerPacket[0]==NULL);
    transition();
    assert(LiSendMultiControllerEvent(0,1,B_FLAG,0,0,17,23,0,0)==0);
    drain();
    assert(wireCount==5 && be32(wire[4].bytes+8)==4);
    NV_MULTI_CONTROLLER_PACKET packet;
    memcpy(&packet,wire[4].bytes+16,sizeof(packet));
    assert(LE16(packet.buttonFlags)==B_FLAG && LE16(packet.leftStickX)==17);
    teardown();
}
static void testUnicodeWaitCanBeCanceled(void) {
    setup(true); activate();
    atomic_store(&transit,1); atomic_store(&freezeSleep,1);
    assert(LiSendUtf8TextEvent("old",3)==0); startSender(); waitBarrier();
    // This would deadlock if the UTF-8 transit wait held the epoch mutex.
    transition();
    assert(LiSendUtf8TextEvent("new",3)==0);
    atomic_store(&transit,0); atomic_store(&barrierReleased,1);
    waitWire(7); joinSender();
    for(int i=0;i<3;i++) {
        assert(be32(wire[4+i].bytes+8)==4 && wire[4+i].bytes[24]==(unsigned char)"new"[i]);
        assert(wire[4+i].channel==CTRL_CHANNEL_UTF8);
    }
    teardown();
}
static void testPenCannotBatchAcrossEpoch(void) {
    setup(true); activate();
    assert(LiSendPenEvent(LI_TOUCH_EVENT_HOVER,LI_TOOL_TYPE_PEN,0,0,0,0,0,0,0,0)==0);
    startSender(); waitWire(3);
    atomic_store(&freezeSleep,1);
    assert(LiSendPenEvent(LI_TOUCH_EVENT_HOVER,LI_TOOL_TYPE_PEN,0,0,0,0,0,0,0,0)==0);
    waitBarrier(); transition();
    assert(LiSendPenEvent(LI_TOUCH_EVENT_HOVER,LI_TOOL_TYPE_PEN,0,1,1,0,0,0,0,0)==0);
    atomic_store(&barrierReleased,1); waitWire(6); joinSender();
    assert(wireCount==6 && be32(wire[5].bytes+8)==4 && wire[5].channel==CTRL_CHANNEL_PEN && wire[5].flags==0);
    SS_PEN_PACKET packet; netfloat expected; memcpy(&packet,wire[5].bytes+16,sizeof(packet)); floatToNetfloat(1,expected);
    assert(memcmp(packet.x,expected,4)==0);
    teardown();
}
static void testLegacy(void) {
    setup(false);
    assert(LiClipRelayInputCommand(1,true)==-2);
    assert(LiSendKeyboardEvent(65,KEY_ACTION_DOWN,0)==0);
    drain();
    assert(wireCount==1 && wire[0].length==sizeof(NV_KEYBOARD_PACKET));
    teardown();
}
int main(void) {
    PltTicksInit(); assert(PltCreateMutex(&wireMutex)==0);
    testHandshakeAndAllProducers();
    testQueuedDataAndFailures();
    for(int kind=0;kind<4;kind++) testBatchGeneration(kind);
    testFullQueueCannotRetainARecycledController();
    testUnicodeWaitCanBeCanceled();
    testPenCannotBatchAcrossEpoch();
    testLegacy();
    PltDeleteMutex(&wireMutex);
    puts("10 real native input queue scenarios passed (20 public producers gated).");
    return 0;
}
