#include "probe.hpp"
#include "rigctld_client.hpp"

#include <QThread>

// Startup + query timeouts kept short: a wrong model/baud pair will time out
// anyway, so aggressively short deadlines make the scan finish in reasonable
// wall time.
static constexpr int kProbeStartupMs = 1500;
static constexpr int kProbeQueryMs   = 800;

QProcess* spawn_rigctld(const QString& bin, int model, const QString& device,
                        int speed, const QString& host, int port) {
    auto* p = new QProcess();
    p->setProcessChannelMode(QProcess::ForwardedChannels);
    QStringList args = {
        "-m", QString::number(model),
        "-T", host,
        "-t", QString::number(port),
    };
    if (!device.isEmpty()) args << "-r" << device;
    if (speed != 0)        args << "-s" << QString::number(speed);
    p->start(bin.isEmpty() ? QString("rigctld") : bin, args);
    if (!p->waitForStarted(3000)) { delete p; return nullptr; }
    return p;
}

// Try one (model, baud) combination end-to-end: spawn rigctld, wait for it
// to bind its port, send "f".  Kills the child before returning.
static bool try_one(const QString& bin, int model, int baud,
                   const QString& device, const QString& host) {
    int port = find_free_port();
    if (port <= 0) return false;
    QProcess* rp = spawn_rigctld(bin, model, device, baud, host, port);
    if (!rp) return false;

    bool ok = false;
    if (wait_for_rigctld(host, port, kProbeStartupMs)) {
        try {
            auto reply = rig_query(host, port, "f", kProbeQueryMs);
            auto first = reply.section('\n', 0, 0).trimmed();
            bool parsed = false;
            long long f = first.toLongLong(&parsed);
            if (parsed && f > 0) ok = true;
        } catch (const RigError&) { /* wrong baud/model — silent */ }
    }
    rp->terminate();
    if (!rp->waitForFinished(500)) rp->kill();
    rp->waitForFinished(200);
    delete rp;
    return ok;
}

std::optional<int>
detect_baud(const QString& rigctld_bin, int model, const QString& device,
            const QString& host, int floor_speed,
            std::function<void(const QString&)> progress,
            std::function<bool()> cancelled) {
    for (int b : probe_bauds()) {
        if (cancelled && cancelled()) return std::nullopt;
        if (floor_speed > 0 && b < floor_speed) continue;
        if (progress) progress(QString("trying %1 baud…").arg(b));
        if (try_one(rigctld_bin, model, b, device, host)) return b;
    }
    return std::nullopt;
}

std::optional<DetectResult>
detect_model(const QString& rigctld_bin, const QString& device,
             const QString& host, const QVector<RigPreset>& rigs,
             std::function<void(const QString&)> progress,
             std::function<bool()> cancelled) {
    int i = 0;
    for (const auto& r : rigs) {
        int floor = r.defaultSpeed;   // if we know a good baud, don't waste time below it
        for (int b : probe_bauds()) {
            if (cancelled && cancelled()) return std::nullopt;
            if (floor > 0 && b < floor) continue;
            if (progress) {
                progress(QString("[%1/%2] %3 %4 @ %5")
                    .arg(++i).arg(rigs.size() * probe_bauds().size())
                    .arg(r.vendor, r.label).arg(b));
            }
            if (try_one(rigctld_bin, r.model, b, device, host)) {
                return DetectResult{r.model, b, r.vendor + " " + r.label};
            }
        }
    }
    return std::nullopt;
}
