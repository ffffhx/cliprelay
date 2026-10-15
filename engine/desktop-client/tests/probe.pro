QT += core network gui
CONFIG += console c++17
CONFIG -= app_bundle
TEMPLATE = app
TARGET = cliprelay-probe
isEmpty(MOONLIGHT_SOURCE): error(MOONLIGHT_SOURCE is required)
INCLUDEPATH += $$MOONLIGHT_SOURCE/app $$MOONLIGHT_SOURCE/app/backend $$MOONLIGHT_SOURCE/app/streaming
INCLUDEPATH += $$MOONLIGHT_SOURCE/moonlight-common-c/moonlight-common-c/src
SOURCES += $$PWD/probe.cpp $$MOONLIGHT_SOURCE/app/backend/sessionimport.cpp \
    $$MOONLIGHT_SOURCE/app/backend/identitymanager.cpp $$MOONLIGHT_SOURCE/app/backend/nvhttp.cpp \
    $$MOONLIGHT_SOURCE/app/backend/nvaddress.cpp $$MOONLIGHT_SOURCE/app/backend/nvapp.cpp
HEADERS += $$MOONLIGHT_SOURCE/app/backend/nvhttp.h
LIBS += -lssl -lcrypto
