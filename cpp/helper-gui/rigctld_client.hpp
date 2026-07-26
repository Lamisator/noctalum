#pragma once

#include <QString>
#include <cstdint>
#include <stdexcept>

class RigError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Send one command to rigctld and return the reply body (without the
// trailing "RPRT 0").  Uses QTcpSocket + shutdown(WR) to force a flush.
// Throws RigError on transport or protocol failure.
QString rig_query(const QString& host, int port, const QString& cmd,
                  int timeout_ms = 5000);

struct RigState {
    int64_t freq_hz = 0;
    QString mode;
};
RigState read_rig(const QString& host, int port);

void set_rig_freq(const QString& host, int port, int64_t freq_hz);
void set_rig_mode(const QString& host, int port, const QString& mode);

// Ask the OS for a free TCP port on 127.0.0.1.
int find_free_port();

// Block until rigctld on host:port accepts a connection or timeout expires.
bool wait_for_rigctld(const QString& host, int port, int timeout_ms);
