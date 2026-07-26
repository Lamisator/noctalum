#pragma once

#include "types.hpp"
#include <QProcess>
#include <QString>
#include <functional>
#include <optional>

// Common baud rates the auto-detect walks through, fastest first — the more
// throughput the rig supports the smoother the polling loop feels.
inline QVector<int> probe_bauds() { return {115200, 57600, 38400, 19200, 9600, 4800}; }

// Spawn rigctld with the given knobs and return the running QProcess (owned
// by the caller — kill via QProcess::terminate/kill).  Returns nullptr on
// spawn failure.  Sets the process to inherit stderr so operators see
// rigctld's own diagnostics interleaved with helper output.
QProcess* spawn_rigctld(const QString& bin, int model, const QString& device,
                        int speed, const QString& host, int port);

// Result of one detection pass.  `label` is populated only by detect_model
// (it names which rig actually answered).
struct DetectResult {
    int model = 0;
    int baud  = 0;
    QString label;
};

// Try each baud in `probe_bauds()` in order, respecting `floor_speed` (skips
// bauds slower than that when a preset is known).  Emits `progress(msg)`
// after each attempt so the UI can show "trying 19200…".  Returns the winning
// baud on success, std::nullopt on total failure.
std::optional<int>
detect_baud(const QString& rigctld_bin, int model, const QString& device,
            const QString& host, int floor_speed,
            std::function<void(const QString&)> progress,
            std::function<bool()> cancelled);

// Iterate every rig in `rigs` × every baud in `probe_bauds()`; return the
// first combination that answers the `f` query with a valid frequency.
// Curated rigs first, others after, so common contest rigs win quickly.
std::optional<DetectResult>
detect_model(const QString& rigctld_bin, const QString& device,
             const QString& host, const QVector<RigPreset>& rigs,
             std::function<void(const QString&)> progress,
             std::function<bool()> cancelled);
