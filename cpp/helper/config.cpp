#include "config.hpp"

#include <cerrno>
#include <fcntl.h>
#include <fstream>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace nhelper {

static std::string home_dir() {
    if (const char* h = std::getenv("HOME")) return h;
    return "";
}

std::string config_dir() {
    if (const char* x = std::getenv("XDG_CONFIG_HOME"); x && *x) {
        return std::string(x) + "/noctalum";
    }
    return home_dir() + "/.config/noctalum";
}

static std::string legacy_dir() {
    if (const char* x = std::getenv("XDG_CONFIG_HOME"); x && *x) {
        return std::string(x) + "/contestlog";
    }
    return home_dir() + "/.config/contestlog";
}

static std::string read_file(const std::string& path) {
    std::ifstream f(path);
    if (!f) return {};
    std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    return s;
}

// Populate cfg from a "shared profile store" JSON blob (the GUI's format).
// Returns true if we found a usable profile.
static bool from_shared_store(const std::string& data, Config& out) {
    try {
        auto j = json::parse(data);
        auto& profs = j.at("profiles");
        if (!profs.is_array() || profs.empty()) return false;
        // Prefer the "last_used" entry when present.
        std::string last = j.value("last_used", "");
        json p = profs[0];
        if (!last.empty()) {
            for (auto& q : profs) {
                if (q.value("name", "") == last) { p = q; break; }
            }
        }
        out.server      = p.value("server", out.server);
        out.name        = p.value("rig_name", "");
        out.token       = p.value("token", "");
        out.rig_model   = p.value("rig_model", 0);
        out.rig_device  = p.value("rig_device", "");
        out.rig_speed   = p.value("rig_speed", 0);
        out.rigctld_bin = p.value("rigctld_bin", "");
        out.interval_ms = p.value("interval_ms", 1000);
        return true;
    } catch (...) {
        return false;
    }
}

// Populate cfg from the flat TUI-only JSON blob.  Fields match tuiConfig.
static bool from_flat(const std::string& data, Config& out) {
    try {
        auto j = json::parse(data);
        out.server      = j.value("server", out.server);
        out.name        = j.value("name", "");
        out.token       = j.value("token", "");
        out.rig_model   = j.value("rig_model", 0);
        out.rig_device  = j.value("rig_device", "");
        out.rig_speed   = j.value("rig_speed", 0);
        out.rigctld_bin = j.value("rigctld_bin", "");
        out.interval_ms = j.value("interval_ms", 1000);
        return true;
    } catch (...) {
        return false;
    }
}

Config load_config() {
    Config c;
    std::string s;

    // 1 + 3: shared GUI store, current then legacy path.
    for (const auto& path : {config_dir() + "/noctalum-helper-gui.json",
                             legacy_dir() + "/contestlog-helper-gui.json"}) {
        s = read_file(path);
        if (!s.empty() && from_shared_store(s, c)) return c;
    }
    // 2 + 4: TUI-only flat file, current then legacy.
    for (const auto& path : {config_dir() + "/noctalum-helper.json",
                             legacy_dir() + "/contestlog-helper.json"}) {
        s = read_file(path);
        if (!s.empty() && from_flat(s, c)) return c;
    }
    return c;
}

// mkdir -p with mode 0700 (matching Go).  Returns true on success or if the
// directory already exists.
static bool mkdirs(const std::string& path) {
    std::string p;
    for (size_t i = 1; i <= path.size(); ++i) {
        if (i == path.size() || path[i] == '/') {
            p = path.substr(0, i);
            if (!p.empty() && mkdir(p.c_str(), 0700) < 0) {
                if (errno != EEXIST) return false;
            }
        }
    }
    return true;
}

static void write_secure(const std::string& path, const std::string& data) {
    mkdirs(path.substr(0, path.find_last_of('/')));
    // Open with 0600 and truncate — matches os.WriteFile(_, _, 0o600).
    int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return;
    ssize_t off = 0;
    while (off < static_cast<ssize_t>(data.size())) {
        ssize_t n = ::write(fd, data.data() + off, data.size() - off);
        if (n <= 0) break;
        off += n;
    }
    ::close(fd);
}

static void save_to_shared(const Config& c) {
    std::string path = config_dir() + "/noctalum-helper-gui.json";
    json store;
    // Try to preserve existing profiles so we don't blow away others.
    auto existing = read_file(path);
    if (!existing.empty()) {
        try { store = json::parse(existing); } catch (...) { store = json::object(); }
    }
    if (!store.is_object()) store = json::object();
    if (!store.contains("profiles") || !store["profiles"].is_array()) store["profiles"] = json::array();

    std::string profile_name = c.name.empty() ? std::string("Default") : c.name;
    json p = {
        {"name",         profile_name},
        {"server",       c.server},
        {"token",        c.token},
        {"rig_name",     c.name},
        {"rig_model",    c.rig_model},
        {"rig_device",   c.rig_device},
        {"rig_speed",    c.rig_speed},
        {"rigctld_bin",  c.rigctld_bin},
        {"interval_ms",  c.interval_ms},
        {"auto_detect",  false},
    };
    bool replaced = false;
    for (auto& q : store["profiles"]) {
        if (q.value("name", "") == profile_name) { q = p; replaced = true; break; }
    }
    if (!replaced) store["profiles"].push_back(p);
    store["last_used"] = profile_name;
    write_secure(path, store.dump(2));
}

static void save_flat_legacy(const Config& c) {
    std::string path = config_dir() + "/noctalum-helper.json";
    json j = {
        {"server",      c.server},
        {"name",        c.name},
        {"token",       c.token},
        {"rig_model",   c.rig_model},
        {"rig_device",  c.rig_device},
        {"rig_speed",   c.rig_speed},
        {"rigctld_bin", c.rigctld_bin},
        {"interval_ms", c.interval_ms},
    };
    write_secure(path, j.dump(2));
}

void save_config(const Config& c) {
    save_to_shared(c);
    save_flat_legacy(c);
}

}  // namespace nhelper
