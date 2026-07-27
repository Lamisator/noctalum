#pragma once

#include <QString>
#include <cstdint>

// Values captured from the config form and forwarded to the worker session.
struct BridgeConfig {
    QString server;   // full URL including scheme; https:// is assumed if omitted
    QString user;
    QString pass;
    QString udp;      // "host:port" — empty host means 0.0.0.0
    bool    forceDup = false;
};

// One contest as returned by GET /api/contests.
struct Contest {
    int64_t id = 0;
    QString name;
    QString stationCall;
    QString status;
};

// One completed QSO parsed from a WSJT-X LOG_QSO packet.  Only the fields
// the server actually uses; the rest of the WSJT-X payload is discarded.
struct LogQSO {
    qint64  timeSec = 0;       // Unix seconds, UTC
    QString call;
    QString grid;
    quint64 freqHz = 0;
    QString mode;
    QString rstSent;
    QString rstReceived;
    QString notes;
};
