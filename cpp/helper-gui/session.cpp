#include "session.hpp"
#include "probe.hpp"
#include "rigctld_client.hpp"
#include "rigs.hpp"

#include <QEventLoop>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkRequest>
#include <QProcess>
#include <QThread>
#include <QTimer>
#include <QUrl>
#include <QUrlQuery>
#include <QtWebSockets/QWebSocket>
#include <memory>

static QString mode_to_rigctld(const QString& mode, int64_t freq_hz) {
    QString m = mode.toUpper();
    if (m == "CW" || m == "USB" || m == "LSB" || m == "FM" || m == "AM" || m == "RTTY") return m;
    if (m == "SSB") return (freq_hz > 0 && freq_hz < 10'000'000) ? "LSB" : "USB";
    if (m == "FT8" || m == "FT4" || m == "PSK31" || m == "PSK63" || m == "JT65" || m == "DIGI") return "USB";
    return {};
}

Session::Session(ConnectRequest req, QObject* parent)
    : QObject(parent), req_(std::move(req)) {
    moveToThread(&thread_);
    connect(&thread_, &QThread::started, this, &Session::run_wrapper);
    connect(&thread_, &QThread::finished, this, &Session::finished);
}

Session::~Session() {
    request_stop();
    thread_.quit();
    thread_.wait(2000);
}

void Session::start() { thread_.start(); }
void Session::request_stop() { stop_ = true; }

void Session::run_wrapper() {
    try { run_(); }
    catch (const std::exception& e) {
        emit logLine(QString("session error: %1").arg(e.what()));
        emit statusChanged(false, e.what());
    }
    thread_.quit();
}

// http[s]:// → ws[s]://, keeping host/port/path intact.
static QString ws_url_for(const QString& server, const QString& name, const QString& token) {
    QUrl u(server);
    QString scheme = (u.scheme() == "https") ? "wss" : "ws";
    QUrlQuery q;
    q.addQueryItem("role",  "helper");
    q.addQueryItem("name",  name);
    q.addQueryItem("token", token);
    QUrl out;
    out.setScheme(scheme);
    out.setHost(u.host());
    if (u.port() > 0) out.setPort(u.port());
    out.setPath("/ws");
    out.setQuery(q);
    return out.toString();
}

void Session::run_() {
    emit statusChanged(true, "");

    // ── Phase 0: optional model auto-detect ─────────────────────────────
    ConnectRequest r = req_;
    QString rig_label;

    if (r.autoDetectModel) {
        emit phaseChanged("model", "active", "scanning Hamlib models…");
        auto rigs = all_rigs(r.rigctldBin);
        auto res = detect_model(r.rigctldBin, r.rigDevice, "127.0.0.1", rigs,
            [this](const QString& msg) { emit phaseChanged("model", "active", msg); },
            [this]                    { return stop_.load(); });
        if (!res) {
            emit phaseChanged("model", "error", "no rig detected");
            emit statusChanged(false, "model auto-detect failed");
            return;
        }
        r.rigModel = res->model;
        r.rigSpeed = res->baud;
        rig_label = res->label;
        emit modelDetected(res->model, res->label, res->baud);
        emit phaseChanged("model", "done", QString("%1 @ %2 baud").arg(res->label).arg(res->baud));
        emit phaseChanged("baud",  "skipped", "");
    } else {
        emit phaseChanged("model", "skipped", "");
    }

    // ── Phase 1: optional baud auto-detect ──────────────────────────────
    if (r.autoDetect && !r.autoDetectModel) {
        emit phaseChanged("baud", "active", "probing baud rates…");
        int floor = 0;
        for (const auto& c : curated_rigs()) if (c.model == r.rigModel) { floor = c.defaultSpeed; break; }
        auto b = detect_baud(r.rigctldBin, r.rigModel, r.rigDevice, "127.0.0.1", floor,
            [this](const QString& msg) { emit phaseChanged("baud", "active", msg); },
            [this]                    { return stop_.load(); });
        if (!b) {
            emit phaseChanged("baud", "error", "no baud rate answered");
            emit statusChanged(false, "baud auto-detect failed");
            return;
        }
        r.rigSpeed = *b;
        emit phaseChanged("baud", "done", QString("%1 baud").arg(*b));
    } else if (!r.autoDetectModel) {
        emit phaseChanged("baud", "skipped", "");
    }

    if (stop_) { emit statusChanged(false, "cancelled"); return; }

    // ── Phase 2: spawn rigctld and wait for it ──────────────────────────
    emit phaseChanged("connecting", "active", "starting rigctld…");
    int port = find_free_port();
    if (port <= 0) {
        emit phaseChanged("connecting", "error", "cannot allocate free port");
        emit statusChanged(false, "no free port");
        return;
    }
    std::unique_ptr<QProcess> rp(spawn_rigctld(r.rigctldBin, r.rigModel, r.rigDevice,
                                               r.rigSpeed, "127.0.0.1", port));
    if (!rp) {
        emit phaseChanged("connecting", "error", "rigctld failed to start");
        emit statusChanged(false, "rigctld start failed");
        return;
    }
    if (!wait_for_rigctld("127.0.0.1", port, 10000)) {
        emit phaseChanged("connecting", "error", "rigctld did not open its TCP port");
        rp->kill(); rp->waitForFinished(500);
        emit statusChanged(false, "rigctld startup timeout");
        return;
    }
    RigctldParams params;
    params.binary   = r.rigctldBin.isEmpty() ? QString("rigctld") : r.rigctldBin;
    params.model    = r.rigModel;
    params.rigLabel = rig_label.isEmpty() ? r.rigName : rig_label;
    params.device   = r.rigDevice;
    params.speed    = r.rigSpeed;
    params.host     = "127.0.0.1";
    params.port     = port;
    QStringList a = {"-m", QString::number(r.rigModel), "-T", "127.0.0.1", "-t", QString::number(port)};
    if (!r.rigDevice.isEmpty()) a << "-r" << r.rigDevice;
    if (r.rigSpeed != 0)        a << "-s" << QString::number(r.rigSpeed);
    params.args = a.join(' ');
    emit rigctldParamsReady(params);
    emit phaseChanged("connecting", "done", QString("rigctld on port %1").arg(port));

    // ── Phase 3: open the WebSocket to Noctalum and start polling ───────
    emit phaseChanged("connected", "active", "opening WebSocket…");
    QWebSocket ws(r.server /* origin */);
    QString url = ws_url_for(r.server, r.rigName, r.token);

    // We block on the "connected" signal via a local event loop so this
    // function stays linear, matching the Go control flow.
    QEventLoop loop;
    bool got_connect = false;
    QString ws_err;
    connect(&ws, &QWebSocket::connected, [&]{ got_connect = true; loop.quit(); });
    connect(&ws, QOverload<QAbstractSocket::SocketError>::of(&QWebSocket::error),
            [&](QAbstractSocket::SocketError){
        ws_err = ws.errorString(); loop.quit();
    });
    ws.open(QUrl(url));
    loop.exec();
    if (!got_connect) {
        emit phaseChanged("connected", "error", ws_err.isEmpty() ? "connection failed" : ws_err);
        rp->kill(); rp->waitForFinished(500);
        emit statusChanged(false, ws_err);
        return;
    }
    emit phaseChanged("connected", "done", "streaming rig updates");
    emit logLine(QString("registered rig \"%1\" at %2").arg(r.rigName, r.server));

    // Inbound frames from server: `set_freq` commands.
    connect(&ws, &QWebSocket::textMessageReceived, [&](const QString& msg) {
        auto doc = QJsonDocument::fromJson(msg.toUtf8());
        auto obj = doc.object();
        if (obj.value("type").toString() != "set_freq") return;
        auto p  = obj.value("payload").toObject();
        int64_t f = p.value("freq_hz").toVariant().toLongLong();
        QString m = p.value("mode").toString();
        if (f <= 0) return;
        try { set_rig_freq("127.0.0.1", port, f); emit logLine(QString("set freq → %1 Hz").arg(f)); }
        catch (const RigError& e) { emit logLine(QString("set_freq %1: %2").arg(f).arg(e.what())); }
        QString translated = mode_to_rigctld(m, f);
        if (!translated.isEmpty()) {
            try { set_rig_mode("127.0.0.1", port, translated); emit logLine("set mode → " + translated); }
            catch (const RigError& e) { emit logLine(QString("set_mode %1: %2").arg(translated, e.what())); }
        }
    });

    int normal = r.intervalMs;
    int tick   = normal;
    const int kMax = 30000;
    int err_count = 0;

    while (!stop_ && ws.state() == QAbstractSocket::ConnectedState) {
        // Process Qt events (WebSocket read side runs in the same thread's
        // event loop) up to the next scheduled poll.
        int slice = std::min(200, tick);
        QEventLoop tickLoop;
        QTimer::singleShot(slice, &tickLoop, &QEventLoop::quit);
        tickLoop.exec();
        if (stop_) break;
        if (ws.state() != QAbstractSocket::ConnectedState) break;

        // Only actually poll every `tick` ms — the loop above services the
        // WS on a shorter cadence so set_freq commands don't queue up.
        static thread_local qint64 last_poll_ns = 0;
        auto now_ns = QDateTime::currentMSecsSinceEpoch();
        if (last_poll_ns != 0 && now_ns - last_poll_ns < tick) continue;
        last_poll_ns = now_ns;

        QString err;
        RigState st{};
        try { st = read_rig("127.0.0.1", port); }
        catch (const RigError& e) { err = e.what(); }

        if (!err.isEmpty()) {
            if (err_count == 0) emit logLine(QString("rig \"%1\" offline: %2").arg(r.rigName, err));
            ++err_count;
            tick = normal;
            for (int i = 0; i < err_count; ++i) { tick *= 2; if (tick >= kMax) { tick = kMax; break; } }
        } else {
            if (err_count > 0) emit logLine(QString("rig \"%1\" back online").arg(r.rigName));
            err_count = 0;
            tick = normal;
        }

        QJsonObject frame{{"type", "rig_update"}};
        if (!err.isEmpty()) frame["error"] = err;
        else {
            frame["freq_hz"] = static_cast<qint64>(st.freq_hz);
            frame["mode"]    = st.mode;
        }
        ws.sendTextMessage(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    }

    ws.close();
    rp->terminate();
    if (!rp->waitForFinished(1000)) rp->kill();
    rp->waitForFinished(500);
    emit statusChanged(false, "");
}
