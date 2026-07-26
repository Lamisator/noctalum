#pragma once

#include "types.hpp"

#include <QObject>
#include <QString>
#include <QThread>
#include <atomic>

// Session runs the connect + poll loop on its own QThread and emits Qt
// signals that mirror the runtime.EventsEmit() calls the Wails GUI relies on.
// One Session per operator click on Connect; Disconnect() cancels it and the
// worker thread cleans up rigctld + WebSocket before quitting.
class Session : public QObject {
    Q_OBJECT
public:
    explicit Session(ConnectRequest req, QObject* parent = nullptr);
    ~Session() override;

    void start();
    void request_stop();

signals:
    // Phase indicator updates for the top-of-window progress row.
    // phase: "model" | "baud" | "connecting" | "connected"
    // state: "idle"  | "active" | "done" | "error" | "skipped"
    void phaseChanged(QString phase, QString state, QString message);
    void logLine(QString msg);
    void statusChanged(bool running, QString error);
    void rigctldParamsReady(RigctldParams p);
    void modelDetected(int model, QString label, int baud);
    void finished();

private:
    // Runs on the worker thread; wraps run_() in a try/catch so unexpected
    // errors still tear down cleanly.
    void run_wrapper();
    void run_();

    ConnectRequest req_;
    QThread        thread_;
    std::atomic<bool> stop_{false};
};
