#pragma once

#include "common.hpp"

namespace nhelper {

// Open one WebSocket session to `server` using `token` as the helper token
// and `rig_name` as the display name, and stream rig_update frames from the
// rigctld at rig_host:rig_port every interval_ms.  Returns when the session
// ends (network error, remote close, or SIGINT).  The caller reconnects in
// a loop with a 5 s pause between attempts, mirroring the Go main.
void run_session(const std::string& server, const std::string& rig_name,
                 const std::string& token, const std::string& rig_host,
                 int rig_port, int interval_ms);

}  // namespace nhelper
