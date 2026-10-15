// SPDX-License-Identifier: GPL-3.0-or-later
#include "sessionimport.h"
#include "identitymanager.h"
#include "nvhttp.h"
#include <QCoreApplication>
#include <QFile>
#include <QSettings>
#include <QTimer>
#include <cstdio>

// Only satisfies the launch URL symbol in NvHTTP; this fixture never launches
// a stream or sends input. TLS and identity code are the production sources.
extern "C" const char* LiGetLaunchUrlQueryParameters(void) { return ""; }

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    QCoreApplication::setOrganizationName("ClipRelay Probe");
    QCoreApplication::setApplicationName("Isolated Test");
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, qEnvironmentVariable("CLIPRELAY_PROBE_SETTINGS"));
    if (!ClipRelayImport::loadStdin()) return 2;
    const auto& session = ClipRelayImport::get();
    auto identity = IdentityManager::get();
    if (identity->getPrivateKey() != session.privateKey || identity->getCertificate() != session.certificate ||
        identity->getUniqueId() != session.clientId || !QSettings().allKeys().isEmpty()) return 3;
    if (app.arguments().contains("--parse")) return 0;
    if (app.arguments().contains("--events")) {
        ClipRelayImport::reportConnected();
        ClipRelayImport::reportConnected();
        ClipRelayImport::reportEnded(ClipRelayImport::EndReason::Network);
        ClipRelayImport::reportEnded(ClipRelayImport::EndReason::User);
        ClipRelayImport::reportConnected();
        return 0;
    }
    if (app.arguments().contains("--progress")) {
        ClipRelayImport::reportReceived(10);
        ClipRelayImport::reportRendered(12,1280,720); // not received
        ClipRelayImport::reportRendered(9,1280,720);
        ClipRelayImport::reportRendered(8,1920,1080); // stale callback
        ClipRelayImport::reportConnected();
        ClipRelayImport::reportProgress();
        ClipRelayImport::reportProgress(); // rate-limited
        QTimer::singleShot(250, &app, [&] {
            ClipRelayImport::reportReceived(20);
            ClipRelayImport::reportRendered(19,1920,1080);
            ClipRelayImport::reportRendered(20,0,1080); // invalid geometry
            ClipRelayImport::reportProgress();
            ClipRelayImport::reportEnded(ClipRelayImport::EndReason::User);
            ClipRelayImport::reportProgress(); // closed session cannot report
            app.quit();
        });
        return app.exec();
    }
    if (app.arguments().contains("--progress-backpressure")) {
        ClipRelayImport::reportConnected();
        const QByteArray fill(1024*1024,'x');
        std::fwrite(fill.constData(),1,fill.size(),stdout); std::fflush(stdout);
        ClipRelayImport::reportProgress();
        return ClipRelayImport::parentAlive()?8:0;
    }
    if (app.arguments().contains("--network-errors")) {
        for (int code : {1, 2, 3, 4, 7, 8}) if (!ClipRelayImport::retryableNetworkError(code)) return 8;
        for (int code : {0, 5, 6, 9, 99, 201, 301}) if (ClipRelayImport::retryableNetworkError(code)) return 9;
        return 0;
    }
    if (app.arguments().contains("--overlay")) return session.overlay && session.overlayPort == 48789 ? 0 : 7;
    if (app.arguments().contains("--lease")) {
        ClipRelayImport::watchParent();
        std::puts("ready"); std::fflush(stdout);
        QTimer::singleShot(10000, &app, [&] { app.exit(4); });
        return app.exec();
    }
    // Also trust a different fixture root: encrypted pinning must still reject
    // its valid chain before the first HTTP request, even without sslErrors.
    if (!qEnvironmentVariableIsEmpty("CLIPRELAY_PROBE_CA")) {
        QFile file(qEnvironmentVariable("CLIPRELAY_PROBE_CA"));
        if (!file.open(QIODevice::ReadOnly)) return 5;
        auto ssl = QSslConfiguration::defaultConfiguration();
        auto roots = ssl.caCertificates(); roots.append(QSslCertificate::fromData(file.readAll()));
        ssl.setCaCertificates(roots); QSslConfiguration::setDefaultConfiguration(ssl);
    }
    try {
        NvHTTP http(NvAddress(session.address, session.port), session.port - 5, session.hostCertificate, true);
        http.getServerInfo(NvHTTP::NVLL_NONE);
        return 0;
    } catch (const GfeHttpResponseException& error) {
        ClipRelayImport::reportEnded(error.getStatusCode() == 401 || error.getStatusCode() == 403 ?
            ClipRelayImport::EndReason::Pairing : ClipRelayImport::EndReason::Host);
        return 6;
    } catch (const QtNetworkReplyException& error) {
        ClipRelayImport::reportEnded(ClipRelayImport::retryableNetworkError(error.getError()) ?
            ClipRelayImport::EndReason::Network : ClipRelayImport::EndReason::Host);
        return 6;
    } catch (const std::exception&) { return 6; }
}
