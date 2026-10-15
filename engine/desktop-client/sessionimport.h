// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <QByteArray>
#include <QString>
#include <QSslCertificate>
#include <functional>

// One ephemeral, already paired connection supplied by the owning desktop app.
// Neither credentials nor the host are written into Moonlight's settings.
namespace ClipRelayImport {
struct Session {
    QString address, clientId;
    quint16 port = 0;
    QByteArray certificate, privateKey;
    QSslCertificate hostCertificate;
    int width = 1920, height = 1080, fps = 60, bitrate = 12000;
    bool fullscreen = false;
    bool overlay = false;
    bool telemetry = false;
    quint16 overlayPort = 0;
};
constexpr int MaxFrame = 65536;
bool parse(const QByteArray& bytes, Session& result);
bool loadStdin();
bool active();
bool parentAlive();
const Session& get();
void watchParent(std::function<void()> onLost = {});
enum class EndReason { Network, Pairing, Host, User, Parent, Decoder };
void reportConnected();
void reportEnded(EndReason reason);
void reportReceived(quint64 frame);
void reportRendered(quint64 frame, int width, int height);
void reportProgress();
bool retryableNetworkError(int error);
}
