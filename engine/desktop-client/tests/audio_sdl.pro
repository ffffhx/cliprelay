QT += core
QT -= gui
CONFIG += console c++17 debug link_pkgconfig
CONFIG -= app_bundle release
TEMPLATE = app
TARGET = cliprelay-audio-sdl
isEmpty(MOONLIGHT_SOURCE): error(MOONLIGHT_SOURCE is required)
isEmpty(AUDIO_RENDERER_SOURCE): error(AUDIO_RENDERER_SOURCE is required)
PKGCONFIG += sdl2
INCLUDEPATH += $$MOONLIGHT_SOURCE/app $$MOONLIGHT_SOURCE/app/streaming/audio/renderers $$MOONLIGHT_SOURCE/moonlight-common-c/moonlight-common-c/src
SOURCES += $$PWD/audio_sdl.cpp $$AUDIO_RENDERER_SOURCE
QMAKE_LFLAGS += -Wl,--wrap=SDL_QueueAudio
