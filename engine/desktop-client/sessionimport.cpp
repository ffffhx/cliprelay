// SPDX-License-Identifier: GPL-3.0-or-later
#include "sessionimport.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QHostAddress>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>
#include <QThread>
#include <QTimer>
#include <QtEndian>
#include <openssl/pem.h>
#include <openssl/x509.h>
#ifdef Q_OS_WIN
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
#endif

namespace ClipRelayImport {
static Session current;
static bool loaded = false;

static bool integer(const QJsonObject& o, const char* key, int low, int high, int& out) {
    auto value = o.value(QLatin1String(key));
    if (!value.isDouble()) return false;
    double number = value.toDouble();
    if (number < low || number > high || number != static_cast<int>(number)) return false;
    out = static_cast<int>(number);
    return true;
}

static bool certificate(const QJsonValue& v, QByteArray& pem, QSslCertificate& cert) {
    if (!v.isString()) return false;
    pem = v.toString().toUtf8();
    if (pem.size() > 16384 || !pem.startsWith("-----BEGIN CERTIFICATE-----") ||
        !pem.trimmed().endsWith("-----END CERTIFICATE-----")) return false;
    const auto certificates = QSslCertificate::fromData(pem);
    if (certificates.size() != 1 || certificates.first().isNull()) return false;
    cert = certificates.first();
    return true;
}

bool parse(const QByteArray& bytes, Session& result) {
    if (bytes.isEmpty() || bytes.size() > MaxFrame) return false;
    QJsonParseError error;
    const auto doc = QJsonDocument::fromJson(bytes, &error);
    if (error.error != QJsonParseError::NoError || !doc.isObject()) return false;
    const auto o = doc.object();
    const QSet<QString> keys{"version", "address", "port", "clientId", "certificate",
        "privateKey", "hostCertificate", "width", "height", "fps", "bitrate", "fullscreen"};
    const auto actualKeys = o.keys();
    if (QSet<QString>(actualKeys.cbegin(), actualKeys.cend()) != keys) return false;
    Session candidate;
    int version = 0, port = 0;
    if (!integer(o, "version", 1, 1, version) || !integer(o, "port", 6, 65514, port) ||
        !integer(o, "width", 320, 7680, candidate.width) ||
        !integer(o, "height", 240, 4320, candidate.height) ||
        !integer(o, "fps", 15, 120, candidate.fps) ||
        !integer(o, "bitrate", 1000, 100000, candidate.bitrate) ||
        !o.value("fullscreen").isBool()) return false;
    candidate.port = static_cast<quint16>(port);
    candidate.fullscreen = o.value("fullscreen").toBool();
    candidate.address = o.value("address").toString();
    QHostAddress ip;
    if (candidate.address.isEmpty() || candidate.address.size() > 253 ||
        (!ip.setAddress(candidate.address) && !QRegularExpression("^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$").match(candidate.address).hasMatch())) return false;
    // Link-local scoped addresses are not supported by the stream transport.
    if (candidate.address.contains('%')) return false;
    candidate.clientId = o.value("clientId").toString();
    if (!QRegularExpression("^[a-f0-9]{32}$").match(candidate.clientId).hasMatch()) return false;
    QByteArray hostPem;
    QSslCertificate clientCert;
    if (!certificate(o.value("certificate"), candidate.certificate, clientCert) ||
        !certificate(o.value("hostCertificate"), hostPem, candidate.hostCertificate) ||
        !o.value("privateKey").isString()) return false;
    candidate.privateKey = o.value("privateKey").toString().toUtf8();
    if (candidate.privateKey.isEmpty() || candidate.privateKey.size() > 16384 ||
        candidate.privateKey.contains("ENCRYPTED")) return false;
    BIO* keyBio = BIO_new_mem_buf(candidate.privateKey.constData(), candidate.privateKey.size());
    BIO* certBio = BIO_new_mem_buf(candidate.certificate.constData(), candidate.certificate.size());
    EVP_PKEY* key = keyBio ? PEM_read_bio_PrivateKey(keyBio, nullptr, nullptr, nullptr) : nullptr;
    X509* cert = certBio ? PEM_read_bio_X509(certBio, nullptr, nullptr, nullptr) : nullptr;
    const bool valid = key && cert && EVP_PKEY_base_id(key) == EVP_PKEY_RSA &&
        EVP_PKEY_bits(key) >= 2048 && X509_check_private_key(cert, key) == 1;
    EVP_PKEY_free(key); X509_free(cert); BIO_free(keyBio); BIO_free(certBio);
    if (!valid) return false;
    result = std::move(candidate);
    return true;
}

// Require a pipe, never read credentials from a terminal or an arbitrary file.
// Four-byte big-endian length, then UTF-8 JSON. The pipe remains open as a lease.
static bool readExact(char* out, int count, QElapsedTimer& elapsed) {
    int readCount = 0;
    while (readCount < count && elapsed.elapsed() < 5000) {
#ifdef Q_OS_WIN
        HANDLE handle = GetStdHandle(STD_INPUT_HANDLE);
        DWORD available = 0, got = 0;
        if (GetFileType(handle) != FILE_TYPE_PIPE || !PeekNamedPipe(handle, nullptr, 0, nullptr, &available, nullptr)) return false;
        if (!available) { QThread::msleep(5); continue; }
        if (!ReadFile(handle, out + readCount, qMin<DWORD>(available, count - readCount), &got, nullptr) || !got) return false;
#else
        pollfd fd{STDIN_FILENO, POLLIN, 0};
        int ready = poll(&fd, 1, 20);
        if (ready < 0) { if (errno == EINTR) continue; return false; }
        if (!ready) continue;
        if (!(fd.revents & POLLIN)) return false;
        ssize_t got = read(STDIN_FILENO, out + readCount, count - readCount);
        if (got <= 0) return false;
#endif
        readCount += static_cast<int>(got);
    }
    return readCount == count;
}

bool loadStdin() {
    if (loaded) return false;
#ifndef Q_OS_WIN
    struct stat inputStat{};
    if (fstat(STDIN_FILENO, &inputStat) || (!S_ISFIFO(inputStat.st_mode) && !S_ISSOCK(inputStat.st_mode))) return false;
#endif
    QElapsedTimer elapsed; elapsed.start();
    char header[4];
    if (!readExact(header, 4, elapsed)) return false;
    quint32 length = qFromBigEndian<quint32>(header);
    if (!length || length > MaxFrame) return false;
    QByteArray bytes(static_cast<int>(length), '\0');
    if (!readExact(bytes.data(), bytes.size(), elapsed)) return false;
    loaded = parse(bytes, current);
    bytes.fill('\0');
    return loaded;
}
bool active() { return loaded; }
const Session& get() { Q_ASSERT(loaded); return current; }
bool parentAlive() {
#ifdef Q_OS_WIN
    DWORD available = 0;
    return PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr) && !available;
#else
    pollfd fd{STDIN_FILENO, POLLIN, 0};
    int result = poll(&fd, 1, 0);
    return result == 0 || (result < 0 && errno == EINTR);
#endif
}
void watchParent(std::function<void()> onLost) {
    auto timer = new QTimer(QCoreApplication::instance());
    QObject::connect(timer, &QTimer::timeout, [timer, onLost] {
        // EOF or unexpected further messages terminate this one-shot session.
        if (!parentAlive()) {
            timer->stop();
            if (onLost) onLost(); else QCoreApplication::quit();
        }
    });
    timer->start(100);
}
}
