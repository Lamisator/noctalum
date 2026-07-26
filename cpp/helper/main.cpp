// noctalum-helper (C++) bridges local Hamlib rigctld to a remote Noctalum
// server.  Behaviour matches cmd/helper (Go): CLI-driven if any flag is set,
// otherwise an interactive ncurses setup screen.

#include "common.hpp"
#include "config.hpp"
#include "rigctld.hpp"
#include "session.hpp"
#include "tui.hpp"
#include "util.hpp"
#include "ws.hpp"

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <signal.h>
#include <string>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

namespace nhelper {

void log_line(const std::string& msg) {
    auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    tm g{}; localtime_r(&now, &g);
    char buf[32]; std::strftime(buf, sizeof buf, "%Y/%m/%d %H:%M:%S", &g);
    std::cerr << buf << " " << msg << "\n";
}

void log_linef(const char* fmt, ...) {
    va_list ap; va_start(ap, fmt);
    char buf[1024]; std::vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    log_line(buf);
}

}  // namespace nhelper

using namespace nhelper;

static std::atomic<pid_t> g_rigctld_pid{-1};

static void kill_rigctld_child() {
    pid_t p = g_rigctld_pid.exchange(-1);
    if (p > 0) {
        ::kill(p, SIGTERM);
        int status = 0;
        // Reap with a short grace period, then force-kill.
        for (int i = 0; i < 20; ++i) {
            if (waitpid(p, &status, WNOHANG) == p) return;
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        ::kill(p, SIGKILL);
        waitpid(p, &status, 0);
    }
}

static void on_signal(int) {
    // Async-signal-safe cleanup: just note the intent, main will handle it.
    kill_rigctld_child();
    _Exit(0);
}

static void usage(int code) {
    std::cerr <<
        "Usage: noctalum-helper [flags]\n"
        "  -server URL       Noctalum server URL (default http://localhost:8080)\n"
        "  -name NAME        rig display name (required unless using the TUI)\n"
        "  -token TOKEN      helper token (required unless using the TUI)\n"
        "  -rig-host HOST    rigctld host (default 127.0.0.1)\n"
        "  -rig-port PORT    rigctld TCP port (default 4532)\n"
        "  -interval MS      polling interval in ms (default 1000, min 250)\n"
        "  -rig-model N      Hamlib rig model — if set, rigctld is spawned automatically\n"
        "  -rig-device DEV   serial device for -rig-model (e.g. /dev/ttyUSB0)\n"
        "  -rig-speed N      serial baud rate (0 = rigctld default)\n"
        "  -rigctld PATH     path to the rigctld binary\n"
        "\n"
        "Running with no flags opens an interactive setup screen.\n";
    std::exit(code);
}

// Split "-flag=value" into ("-flag", "value").  Also handles "-flag value".
static std::string take_value(int argc, char** argv, int& i, const char* name) {
    std::string t = argv[i];
    auto eq = t.find('=');
    if (eq != std::string::npos) return t.substr(eq + 1);
    if (i + 1 >= argc) {
        std::cerr << "error: " << name << " requires a value\n";
        usage(2);
    }
    return argv[++i];
}

int main(int argc, char** argv) {
    Config c;
    c.rigctld_bin = default_rigctld_bin();

    int n_flags = 0;
    for (int i = 1; i < argc; ++i) {
        std::string t = argv[i];
        std::string k = t;
        if (k.rfind("--", 0) == 0) k = k.substr(2);
        else if (k.rfind("-", 0) == 0) k = k.substr(1);
        if (auto eq = k.find('='); eq != std::string::npos) k = k.substr(0, eq);

        if      (k == "server")     { c.server      = take_value(argc, argv, i, "-server");     ++n_flags; }
        else if (k == "name")       { c.name        = take_value(argc, argv, i, "-name");       ++n_flags; }
        else if (k == "token")      { c.token       = take_value(argc, argv, i, "-token");      ++n_flags; }
        else if (k == "rig-host")   { c.rig_host    = take_value(argc, argv, i, "-rig-host");   ++n_flags; }
        else if (k == "rig-port")   { c.rig_port    = std::atoi(take_value(argc, argv, i, "-rig-port").c_str()); ++n_flags; }
        else if (k == "interval")   { c.interval_ms = std::atoi(take_value(argc, argv, i, "-interval").c_str()); ++n_flags; }
        else if (k == "rig-model")  { c.rig_model   = std::atoi(take_value(argc, argv, i, "-rig-model").c_str()); ++n_flags; }
        else if (k == "rig-device") { c.rig_device  = take_value(argc, argv, i, "-rig-device"); ++n_flags; }
        else if (k == "rig-speed")  { c.rig_speed   = std::atoi(take_value(argc, argv, i, "-rig-speed").c_str()); ++n_flags; }
        else if (k == "rigctld")    { c.rigctld_bin = take_value(argc, argv, i, "-rigctld");    ++n_flags; }
        else if (k == "h" || k == "help") usage(0);
        else {
            std::cerr << "unknown flag: " << t << "\n";
            usage(2);
        }
    }

    if (n_flags == 0) {
        auto cfg = run_tui();
        if (!cfg) {
            log_line("cancelled");
            return 0;
        }
        c = *cfg;
    }

    if (c.name.empty())  { std::cerr << "-name is required\n";  return 2; }
    if (c.token.empty()) { std::cerr << "-token is required (see Noctalum Settings)\n"; return 2; }
    if (c.interval_ms < 250) c.interval_ms = 250;

    // Signal handlers so Ctrl-C tears down the child rigctld.
    struct sigaction sa{};
    sa.sa_handler = on_signal;
    sigaction(SIGINT,  &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);
    signal(SIGPIPE, SIG_IGN);

    log_linef("=== Noctalum Helper v%s ===", kHelperVersion);
    log_linef("  server:   %s", c.server.c_str());
    log_linef("  rig name: %s", c.name.c_str());
    if (c.rig_model != 0) {
        log_line ("  rig mode: managed (spawning rigctld)");
        log_linef("  rigctld:  %s", c.rigctld_bin.c_str());
        log_linef("  model:    %d", c.rig_model);
        if (!c.rig_device.empty()) log_linef("  device:   %s", c.rig_device.c_str());
        else                       log_line ("  device:   (none specified — rigctld default)");
        if (c.rig_speed != 0)      log_linef("  speed:    %d baud", c.rig_speed);
        else                       log_line ("  speed:    (none specified — rigctld default)");
    } else {
        log_linef("  rig mode: external rigctld at %s:%d", c.rig_host.c_str(), c.rig_port);
    }
    log_linef("  interval: %d ms", c.interval_ms);

    if (c.rig_model != 0) {
        int port = find_free_port();
        if (port <= 0) { log_line("find free port failed"); return 1; }
        c.rig_port = port;
        pid_t pid = spawn_rigctld(c.rigctld_bin, c.rig_model, c.rig_device,
                                  c.rig_speed, c.rig_host, port);
        if (pid < 0) { log_line("start rigctld failed"); return 1; }
        g_rigctld_pid = pid;
        if (!wait_for_rigctld(c.rig_host, port, std::chrono::seconds(30))) {
            log_line("rigctld did not start within 30 s");
            kill_rigctld_child();
            return 1;
        }
        log_linef("rigctld started (model %d) on port %d", c.rig_model, port);
    }

    // Outer reconnect loop — matches Go's `for { session(...); sleep 5s }`.
    for (;;) {
        try {
            run_session(c.server, c.name, c.token, c.rig_host, c.rig_port, c.interval_ms);
            log_line("session ended: normal close; reconnecting in 5s");
        } catch (const std::exception& e) {
            log_linef("session ended: %s; reconnecting in 5s", e.what());
        }
        std::this_thread::sleep_for(std::chrono::seconds(5));
    }
}
