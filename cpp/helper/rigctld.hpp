#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>

namespace nhelper {

// Thrown by rigctld helpers on any transport or protocol error.  The message
// is a human-readable string suitable for the log or the WebSocket "error"
// field, mirroring what Go's fmt.Errorf produced.
class RigError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Send one command to rigctld, wait for the response, return the body (without
// the trailing "RPRT 0").  Throws RigError on transport failure or non-zero
// RPRT code.  Each call opens its own TCP connection because rigctld replies
// promptly only after the client half-closes the write side.
std::string rig_query(const std::string& host, int port, const std::string& cmd);

// Convenience: read "freq_hz" via `f` and "mode" via `m`.
struct RigState { int64_t freq_hz; std::string mode; };
RigState read_rig(const std::string& host, int port);

// Tune the rig and set the mode; both return normally on success.
void set_rig_freq(const std::string& host, int port, int64_t freq_hz);
void set_rig_mode(const std::string& host, int port, const std::string& mode);

// Block until a rigctld on host:port accepts a TCP connection, or `timeout`
// elapses.  Used after we spawn a child rigctld to make sure it's listening
// before we start hammering it.
bool wait_for_rigctld(const std::string& host, int port, std::chrono::seconds timeout);

// Fork/exec a rigctld subprocess with the given parameters.  Returns the
// child's PID, or -1 on exec failure.  The caller is responsible for kill/
// wait via the standard signal handlers in main.
int spawn_rigctld(const std::string& bin, int model, const std::string& device,
                  int speed, const std::string& host, int port);

}  // namespace nhelper
