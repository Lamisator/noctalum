#pragma once

#include <string>
#include <vector>

namespace nhelper {

// Detect USB serial adapters via /dev/ttyUSB* + /dev/ttyACM* globs.
std::vector<std::string> detect_serial_ports();

// Resolve the rigctld binary path: PATH lookup, otherwise the literal "rigctld".
// (No Homebrew fallbacks; this is a Linux-only build.)
std::string default_rigctld_bin();

// Translate a Noctalum mode string (e.g. "SSB", "FT8") to a rigctld mode name.
// Empty string means "do not touch the mode".  freq_hz is used to resolve
// "SSB" to LSB below 10 MHz and USB above.
std::string to_rigctld_mode(const std::string& mode, int64_t freq_hz);

// Trim ASCII whitespace from both ends.
std::string trim(std::string s);

// Ask the kernel for a free TCP port by binding to 127.0.0.1:0.
int find_free_port();

// Read a line from the given file descriptor with a 5 s deadline, returning
// stdout+stderr up to EOF.  Used to slurp the child rigctld's output for
// diagnostics.  Not currently invoked; kept for future error surfaces.
// (Declared here to keep util.cpp self-contained.)

}  // namespace nhelper
