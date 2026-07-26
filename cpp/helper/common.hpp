// Shared types and constants for the C++ port of cmd/helper.
#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>

namespace nhelper {

constexpr const char* kHelperVersion = "0.1.0";

// Holds every knob the operator can adjust — mirrors both the CLI flags
// and the shared profile JSON.
struct Config {
    std::string server      = "http://localhost:8080";
    std::string name;                     // rig display name (required)
    std::string token;                    // helper token (required)
    std::string rig_host    = "127.0.0.1";
    int         rig_port    = 4532;
    int         interval_ms = 1000;
    int         rig_model   = 0;          // Hamlib model number; 0 = external rigctld
    std::string rig_device;               // e.g. /dev/ttyUSB0
    int         rig_speed   = 0;          // baud rate; 0 = rigctld default
    std::string rigctld_bin;              // absolute path or bare "rigctld"
};

// Formatted log line: prefixed with "YYYY/MM/DD HH:MM:SS " on stderr,
// matching Go's default log package output.
void log_line(const std::string& msg);

// printf-style variant that forwards to log_line.
void log_linef(const char* fmt, ...) __attribute__((format(printf, 1, 2)));

}  // namespace nhelper
