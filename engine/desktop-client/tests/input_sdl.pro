QT += core network
CONFIG += console c++17 debug
CONFIG -= app_bundle release
TEMPLATE = app
TARGET = cliprelay-input-sdl
isEmpty(MOONLIGHT_SOURCE): error(MOONLIGHT_SOURCE is required)
CONFIG += link_pkgconfig
PKGCONFIG += sdl2
INCLUDEPATH += $$PWD/input-fixture $$PWD/.. $$MOONLIGHT_SOURCE/moonlight-common-c/moonlight-common-c/src
SOURCES += $$PWD/input_sdl.cpp $$PWD/../inputepoch.cpp
