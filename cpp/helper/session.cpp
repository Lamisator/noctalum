#include "session.hpp"
#include "rigctld.hpp"
#include "util.hpp"
#include "ws.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <nlohmann/json.hpp>
#include <thread>

using json = nlohmann::json;
using namespace std::chrono_literals;

namespace nhelper {

// URL-encode a single query-parameter value.  Enough for our use — we only
// need alnum, dash, dot, underscore to pass through unescaped; everything
// else is %HH.
static std::string url_encode(const std::string& s) {
    static const char hex[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 0xF]);
        }
    }
    return out;
}

// http[s]://host[:port] → ws[s]://host[:port].
static std::string ws_scheme(const std::string& server) {
    if (server.rfind("https://", 0) == 0) return "wss://" + server.substr(8);
    if (server.rfind("http://",  0) == 0) return "ws://"  + server.substr(7);
    // Bare host:port → default to plain ws:// (mirrors Go's url.Parse behaviour).
    return "ws://" + server;
}

// Exponential backoff: base × 2^err_count, clamped to max.
static std::chrono::milliseconds backoff(std::chrono::milliseconds base,
                                         std::chrono::milliseconds max,
                                         int err_count) {
    auto d = base;
    for (int i = 0; i < err_count; ++i) {
        d *= 2;
        if (d >= max) return max;
    }
    return d;
}

void run_session(const std::string& server, const std::string& rig_name,
                 const std::string& token, const std::string& rig_host,
                 int rig_port, int interval_ms) {
    std::string ws_url = ws_scheme(server) + "/ws?role=helper&name=" +
                         url_encode(rig_name) + "&token=" + url_encode(token);

    WsClient ws;
    // Server frames are inbound "set_freq" commands.  Handle them inline —
    // it's a rare event compared to the polling loop.
    ws.on_text([&](const std::string& msg) {
        try {
            auto ev = json::parse(msg);
            if (ev.value("type", "") != "set_freq") return;
            const auto& p = ev.at("payload");
            int64_t f = p.value("freq_hz", int64_t{0});
            std::string m = p.value("mode", "");
            if (f <= 0) return;
            try {
                set_rig_freq(rig_host, rig_port, f);
                log_linef("set freq → %lld Hz", static_cast<long long>(f));
            } catch (const RigError& e) {
                log_linef("set_freq %lld: %s", static_cast<long long>(f), e.what());
            }
            std::string translated = to_rigctld_mode(m, f);
            if (!translated.empty()) {
                try {
                    set_rig_mode(rig_host, rig_port, translated);
                    log_linef("set mode → %s", translated.c_str());
                } catch (const RigError& e) {
                    log_linef("set_mode %s: %s", translated.c_str(), e.what());
                }
            }
        } catch (const std::exception&) {
            // Malformed frame — drop silently, same as Go's json.Unmarshal skip.
        }
    });

    ws.connect(ws_url);
    log_linef("registered rig \"%s\" at %s", rig_name.c_str(), server.c_str());

    auto normal = std::chrono::milliseconds(interval_ms);
    auto maxbo  = std::chrono::seconds(30);
    auto tick   = normal;
    int err_count = 0;
    auto next = std::chrono::steady_clock::now();

    for (;;) {
        // Service the WebSocket until the next scheduled poll.  This lets
        // inbound set_freq commands arrive promptly without a dedicated thread.
        while (std::chrono::steady_clock::now() < next) {
            auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 next - std::chrono::steady_clock::now()).count();
            if (remaining <= 0) break;
            if (!ws.service(static_cast<int>(std::min<int64_t>(remaining, 100)))) {
                throw WsError("connection closed");
            }
        }
        next = std::chrono::steady_clock::now() + tick;

        std::string err_msg;
        RigState st{};
        try {
            st = read_rig(rig_host, rig_port);
        } catch (const RigError& e) {
            err_msg = e.what();
        }

        if (!err_msg.empty()) {
            if (err_count == 0) log_linef("rig \"%s\" offline: %s", rig_name.c_str(), err_msg.c_str());
            ++err_count;
            tick = backoff(normal, std::chrono::duration_cast<std::chrono::milliseconds>(maxbo), err_count);
        } else {
            if (err_count > 0) log_linef("rig \"%s\" back online", rig_name.c_str());
            err_count = 0;
            tick = normal;
        }

        json out = {{"type", "rig_update"}};
        if (!err_msg.empty()) out["error"] = err_msg;
        else {
            out["freq_hz"] = st.freq_hz;
            out["mode"]    = st.mode;
        }
        ws.send_text(out.dump());
    }
}

}  // namespace nhelper
