#include "session.hpp"
#include "wsjtx_protocol.hpp"

#include <QByteArray>
#include <QDateTime>
#include <QHostAddress>
#include <QTimeZone>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QUrl>

namespace {

// Strip trailing "/" so we can safely append "/api/…".
QString normaliseBase(QString s) {
    while (s.endsWith('/')) s.chop(1);
    return s;
}

// Extract {"error": "..."} from JSON error bodies; fall back to raw body.
QString extractError(const QByteArray& body) {
    auto doc = QJsonDocument::fromJson(body);
    if (doc.isObject()) {
        auto v = doc.object().value("error");
        if (v.isString()) return v.toString();
    }
    return QString::fromUtf8(body);
}

// UTC time_t → RFC3339, matching the format the server accepts.
// Uses the QTimeZone overload — the Qt::TimeSpec form is deprecated in
// Qt 6.6+.  QTimeZone::utc() (static method) exists back to Qt 5.2, so
// this compiles cleanly on Debian bookworm's Qt 6.4 and on Fedora 41's
// Qt 6.7 alike.  QTimeZone::UTC (the enum-style constant) would have
// been prettier but that was only added in Qt 6.5.
QString rfc3339Utc(qint64 secs) {
    return QDateTime::fromSecsSinceEpoch(secs, QTimeZone::utc()).toString(Qt::ISODate);
}

// "host:port" → (host, port).  host may be empty for the wildcard interface.
bool splitHostPort(const QString& hp, QString& host, quint16& port) {
    int colon = hp.lastIndexOf(':');
    if (colon < 0) return false;
    host = hp.left(colon);
    bool ok = false;
    int p = hp.mid(colon + 1).toInt(&ok);
    if (!ok || p < 0 || p > 65535) return false;
    port = static_cast<quint16>(p);
    return true;
}

}  // namespace

Session::Session(QObject* parent) : QObject(parent) {
    // Qt's default cookie jar keeps the session cookie in memory, which is
    // all we need for CSRF + auth to work across the login → contest select
    // → QSO POST flow.
    nam_.setCookieJar(new QNetworkCookieJar(&nam_));
    connect(&udp_, &QUdpSocket::readyRead, this, &Session::onDatagramReady);
}

void Session::reset() {
    csrf_.clear();
    helperToken_.clear();
    tokenContestID_ = 0;
    tokenStationCall_.clear();
    nam_.setCookieJar(new QNetworkCookieJar(&nam_));
}

// Extracts the "home" callsign component from cs, mirroring the server's
// internal/server/validate.go BaseCallsign() helper: strip optional
// leading ITU prefix and trailing portable/status suffixes (/P, /MM,
// /QRP) by picking the longest slash-separated token that contains a
// digit and is at least 3 characters long.  Comparing base calls means
// "DM2LAP/P" still matches "DM2LAP".
static QString baseCallsign(QString cs) {
    cs = cs.trimmed().toUpper();
    if (cs.isEmpty() || !cs.contains('/')) return cs;
    QString base;
    for (const QString& p : cs.split('/', Qt::SkipEmptyParts)) {
        bool hasDigit = false;
        for (QChar c : p) { if (c.isDigit()) { hasDigit = true; break; } }
        if (p.size() < 3 || !hasDigit) continue;
        if (p.size() > base.size()) base = p;
    }
    return base.isEmpty() ? cs : base;
}

// ── Token-based auth ────────────────────────────────────────────────────

std::optional<BridgeToken> Session::decodeToken(const QString& blob) {
    // Expected shape: "noc1." + base64url(JSON{"s":"…","t":"…","c":N}).
    // Kept intentionally strict so a paste of the wrong string produces a
    // clear "invalid token" error instead of a mysterious HTTP failure
    // three steps later.
    QString s = blob.trimmed();
    const QString prefix = QStringLiteral("noc1.");
    if (!s.startsWith(prefix)) return std::nullopt;
    QByteArray raw = s.mid(prefix.size()).toUtf8();
    // Qt's Base64UrlEncoding decoder accepts unpadded input, matching the
    // encoding the web UI produces.
    QByteArray json = QByteArray::fromBase64(raw,
        QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
    if (json.isEmpty()) return std::nullopt;
    auto doc = QJsonDocument::fromJson(json);
    if (!doc.isObject()) return std::nullopt;
    auto o = doc.object();
    BridgeToken tk;
    tk.serverBase  = o.value("s").toString().trimmed();
    tk.helperToken = o.value("t").toString().trimmed();
    tk.contestID   = static_cast<qint64>(o.value("c").toDouble());
    tk.stationCall = o.value("sc").toString().trimmed().toUpper();
    if (tk.serverBase.isEmpty() || tk.helperToken.isEmpty() || tk.contestID <= 0) {
        return std::nullopt;
    }
    // Same "bare host:port → https://" default the login flow applies,
    // so pre-token config files that only carry a hostname keep working.
    if (!tk.serverBase.startsWith("http://") && !tk.serverBase.startsWith("https://")) {
        tk.serverBase = "https://" + tk.serverBase;
    }
    return tk;
}

bool Session::configureToken(const QString& blob) {
    auto tk = decodeToken(blob);
    if (!tk) {
        emit errorRaised(tr("Bridge token is not valid — paste the whole \"noc1.…\" string from the Noctalum web UI."));
        return false;
    }
    serverBase_       = normaliseBase(tk->serverBase);
    helperToken_      = tk->helperToken;
    tokenContestID_   = tk->contestID;
    tokenStationCall_ = tk->stationCall;
    csrf_.clear();
    return true;
}

bool Session::isListening() const {
    return udp_.state() == QAbstractSocket::BoundState;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

void Session::httpJson(const QString& method,
                       const QString& url,
                       const QByteArray& body,
                       std::function<void(int, QByteArray, QString)> cb) {
    QNetworkRequest req{QUrl(url)};
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    if (method != "GET") {
        req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        if (!csrf_.isEmpty()) req.setRawHeader("X-CSRF-Token", csrf_.toUtf8());
    }
    // Token-mode QSO submissions authenticate purely by header — no cookie
    // session exists, so the CSRF header above is a no-op.
    if (!helperToken_.isEmpty()) {
        req.setRawHeader("X-Helper-Token", helperToken_.toUtf8());
    }

    QNetworkReply* reply = nullptr;
    if      (method == "GET")  reply = nam_.get(req);
    else if (method == "POST") reply = nam_.post(req, body);
    else                       reply = nam_.sendCustomRequest(req, method.toUtf8(), body);

    connect(reply, &QNetworkReply::finished, this, [reply, cb = std::move(cb)]() {
        // Any non-zero HTTP status came from the server and is passed through
        // to the callback (it inspects the body for 4xx/5xx errors).  A zero
        // status means Qt never reached the server — DNS, TLS, TCP failure —
        // and gets surfaced as a transport error string instead.
        int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        QByteArray body = reply->readAll();
        QString transportErr;
        if (status == 0 && reply->error() != QNetworkReply::NoError) {
            transportErr = reply->errorString();
        }
        reply->deleteLater();
        cb(status, body, transportErr);
    });
}

// ── Login flow ──────────────────────────────────────────────────────────

void Session::login(const BridgeConfig& cfg) {
    serverBase_ = normaliseBase(cfg.server);
    // Bare host:port → assume https:// (same default as the CLI bridge).
    if (!serverBase_.startsWith("http://") && !serverBase_.startsWith("https://")) {
        serverBase_ = "https://" + serverBase_;
    }
    QJsonObject payload{{"username", cfg.user}, {"password", cfg.pass}};
    QByteArray body = QJsonDocument(payload).toJson(QJsonDocument::Compact);

    httpJson("POST", serverBase_ + "/api/login", body,
             [this](int status, QByteArray body, QString xerr) {
        if (!xerr.isEmpty()) { emit errorRaised(xerr); return; }
        if (status != 200) {
            emit errorRaised(QString("HTTP %1: %2").arg(status).arg(extractError(body)));
            return;
        }
        auto doc = QJsonDocument::fromJson(body);
        QString token = doc.object().value("csrf_token").toString();
        if (token.isEmpty()) { emit errorRaised("login response missing csrf_token"); return; }
        csrf_ = token;
        emit loggedIn();
    });
}

void Session::fetchContests() {
    httpJson("GET", serverBase_ + "/api/contests", {},
             [this](int status, QByteArray body, QString xerr) {
        if (!xerr.isEmpty()) { emit errorRaised(xerr); return; }
        if (status != 200) {
            emit errorRaised(QString("HTTP %1: %2").arg(status).arg(extractError(body)));
            return;
        }
        QList<Contest> out;
        auto arr = QJsonDocument::fromJson(body).array();
        out.reserve(arr.size());
        for (auto v : arr) {
            auto o = v.toObject();
            Contest c;
            c.id          = static_cast<qint64>(o.value("id").toDouble());
            c.name        = o.value("name").toString();
            c.stationCall = o.value("station_call").toString();
            c.status      = o.value("status").toString();
            out.append(c);
        }
        emit contestsFetched(std::move(out));
    });
}

void Session::selectContest(qint64 id) {
    QString url = serverBase_ + QString("/api/contests/%1/select").arg(id);
    httpJson("POST", url, "{}",
             [this, id](int status, QByteArray body, QString xerr) {
        if (!xerr.isEmpty()) { emit errorRaised(xerr); return; }
        if (status != 200) {
            emit errorRaised(QString("HTTP %1: %2").arg(status).arg(extractError(body)));
            return;
        }
        emit contestSelected(id);
    });
}

// ── UDP listener ────────────────────────────────────────────────────────

void Session::startListening(const QString& udpAddr, bool forceDup) {
    forceDup_ = forceDup;
    if (udp_.state() != QAbstractSocket::UnconnectedState) udp_.close();

    QString host; quint16 port = 0;
    if (!splitHostPort(udpAddr, host, port)) {
        emit errorRaised(QString("bad UDP address \"%1\"").arg(udpAddr));
        return;
    }
    QHostAddress addr;
    if (host.isEmpty() || host == "0.0.0.0") addr = QHostAddress::Any;
    else if (!addr.setAddress(host))         { emit errorRaised("bad UDP host"); return; }

    // Multicast groups (224.0.0.0/4) need a JoinMulticastGroup after bind —
    // otherwise the bind alone only receives unicast to that address.  The
    // Go/C++ CLI bridges do the same.
    bool multicast = (addr.protocol() == QAbstractSocket::IPv4Protocol &&
                      addr.toIPv4Address() >= 0xE0000000u &&
                      addr.toIPv4Address() <  0xF0000000u);

    QHostAddress bindAddr = multicast ? addr : QHostAddress::AnyIPv4;
    if (!udp_.bind(bindAddr, port, QUdpSocket::ShareAddress | QUdpSocket::ReuseAddressHint)) {
        emit errorRaised(QString("bind %1:%2 failed: %3")
                             .arg(bindAddr.toString()).arg(port).arg(udp_.errorString()));
        return;
    }
    if (multicast && !udp_.joinMulticastGroup(addr)) {
        emit errorRaised(QString("join multicast %1 failed: %2")
                             .arg(addr.toString()).arg(udp_.errorString()));
        udp_.close();
        return;
    }
    emit listeningStarted(QString("%1:%2").arg(bindAddr.toString()).arg(port));
}

void Session::stopListening() {
    if (udp_.state() == QAbstractSocket::UnconnectedState) return;
    udp_.close();
    emit listeningStopped();
}

void Session::onDatagramReady() {
    while (udp_.hasPendingDatagrams()) {
        QByteArray buf;
        buf.resize(int(udp_.pendingDatagramSize()));
        udp_.readDatagram(buf.data(), buf.size());
        auto qso = parseLogQso(buf);
        if (!qso) continue;

        // Client-side callsign filter: when the token names a specific
        // station callsign, drop any QSO whose WSJT-X MyCall isn't the
        // same on a base-callsign basis (DM2LAP still matches DM2LAP/P).
        // The operator sees a warn line in the Activity log so it's
        // clear why nothing hit the server.  Server-side re-checks the
        // same rule on /api/wsjtx/qsos as a safety net.
        if (!tokenStationCall_.isEmpty() && !qso->myCall.isEmpty() &&
            baseCallsign(qso->myCall) != baseCallsign(tokenStationCall_)) {
            emit qsoFailed(*qso, tr(
                "skipped — WSJT-X station callsign %1 doesn't match the contest station %2")
                .arg(qso->myCall, tokenStationCall_));
            continue;
        }

        QJsonObject payload{
            {"callsign",     qso->call},
            {"freq_hz",      static_cast<qint64>(qso->freqHz)},
            {"mode",         qso->mode},
            {"rst_sent",     qso->rstSent},
            {"rst_received", qso->rstReceived},
            {"locator",      qso->grid},
            {"time",         rfc3339Utc(qso->timeSec)},
        };
        if (!qso->notes.isEmpty()) payload["notes"] = qso->notes;

        // Token mode uses a dedicated endpoint that authenticates via
        // X-Helper-Token and reads the target contest from the body — no
        // session cookie, no /api/contests/*/select roundtrip.  We also
        // forward WSJT-X's MyCall so the server can enforce the same
        // station-callsign check the client just made.
        const bool tokenMode = !helperToken_.isEmpty();
        if (tokenMode) {
            payload["contest_id"] = tokenContestID_;
            if (!qso->myCall.isEmpty()) payload["my_call"] = qso->myCall;
        }

        QString url = serverBase_ + (tokenMode ? "/api/wsjtx/qsos" : "/api/qsos");
        if (forceDup_) url += "?force=1";

        LogQSO captured = *qso;
        httpJson("POST", url, QJsonDocument(payload).toJson(QJsonDocument::Compact),
                 [this, captured](int status, QByteArray body, QString xerr) {
            if (!xerr.isEmpty()) { emit qsoFailed(captured, xerr); return; }
            if (status == 201) { emit qsoLogged(captured); return; }
            if (status == 409) {
                emit qsoFailed(captured, tr("possible duplicate (enable “Log duplicates” to override)"));
                return;
            }
            emit qsoFailed(captured, QString("HTTP %1: %2").arg(status).arg(extractError(body)));
        });
    }
}
