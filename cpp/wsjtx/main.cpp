// noctalum-wsjtx (C++) bridges WSJT-X to a remote Noctalum server.
// Ported from cmd/wsjtx (Go). Behaviour is identical: log in with
// username/password, pick a contest, listen on UDP for WSJT-X LOG_QSO
// messages, POST each one to the server.
//
// Linux-only build, packaged as an AppImage.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <termios.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include <curl/curl.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace {

constexpr uint32_t kWsjtxMagic  = 0xADBCCBDAu;
constexpr uint32_t kMsgLogQSO   = 5u;
constexpr int64_t  kJulianEpoch = 2440588;  // Julian day of 1970-01-01

// ---------- CLI arg parsing ----------

struct Args {
    std::string server   = "http://localhost:8080";
    std::string user;
    std::string pass;
    bool        pass_set = false;
    std::string udp      = "0.0.0.0:2237";
    bool        force_dup = false;
};

[[noreturn]] void usage(int code) {
    std::cerr <<
        "Usage: noctalum-wsjtx [flags]\n"
        "  -server URL      Noctalum server URL (default http://localhost:8080)\n"
        "  -user NAME       username (required)\n"
        "  -pass PASSWORD   password (omit to be prompted)\n"
        "  -udp HOST:PORT   UDP listen address (default 0.0.0.0:2237)\n"
        "  -force-dup       submit QSOs even if the server flags them as duplicates\n";
    std::exit(code);
}

Args parse_args(int argc, char** argv) {
    Args a;
    // Accept both -flag and --flag; -flag VALUE and -flag=VALUE.
    auto take_value = [&](int& i, std::string_view name) -> std::string {
        std::string tok = argv[i];
        auto eq = tok.find('=');
        if (eq != std::string::npos) return tok.substr(eq + 1);
        if (i + 1 >= argc) {
            std::cerr << "error: " << name << " requires a value\n";
            usage(2);
        }
        return argv[++i];
    };
    for (int i = 1; i < argc; ++i) {
        std::string_view t = argv[i];
        auto strip = [](std::string_view s) {
            if (s.substr(0, 2) == "--") s.remove_prefix(2);
            else if (!s.empty() && s[0] == '-') s.remove_prefix(1);
            auto eq = s.find('=');
            return eq == std::string_view::npos ? s : s.substr(0, eq);
        };
        std::string_view key = strip(t);
        if      (key == "server")    a.server = take_value(i, "-server");
        else if (key == "user")      a.user   = take_value(i, "-user");
        else if (key == "pass")    { a.pass = take_value(i, "-pass"); a.pass_set = true; }
        else if (key == "udp")       a.udp    = take_value(i, "-udp");
        else if (key == "force-dup") a.force_dup = true;
        else if (key == "h" || key == "help") usage(0);
        else {
            std::cerr << "error: unknown flag: " << t << "\n";
            usage(2);
        }
    }
    return a;
}

// ---------- password prompt (no echo) ----------

std::string prompt_password() {
    std::cerr << "Password: ";
    termios old{}, quiet{};
    bool have_tty = tcgetattr(STDIN_FILENO, &old) == 0;
    if (have_tty) {
        quiet = old;
        quiet.c_lflag &= ~ECHO;
        tcsetattr(STDIN_FILENO, TCSANOW, &quiet);
    }
    std::string pw;
    std::getline(std::cin, pw);
    if (have_tty) tcsetattr(STDIN_FILENO, TCSANOW, &old);
    std::cerr << "\n";
    return pw;
}

// ---------- libcurl HTTP client with cookie jar ----------

size_t curl_write_cb(void* ptr, size_t sz, size_t nm, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(static_cast<char*>(ptr), sz * nm);
    return sz * nm;
}

struct HttpClient {
    CURL* handle = nullptr;
    std::string csrf;   // filled after login; sent as X-CSRF-Token on POSTs

    HttpClient() {
        handle = curl_easy_init();
        if (!handle) throw std::runtime_error("curl_easy_init failed");
        // In-memory cookie jar: "-" activates the engine without a file.
        curl_easy_setopt(handle, CURLOPT_COOKIEFILE, "");
        curl_easy_setopt(handle, CURLOPT_TIMEOUT, 15L);
        curl_easy_setopt(handle, CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(handle, CURLOPT_WRITEFUNCTION, curl_write_cb);
    }
    ~HttpClient() { if (handle) curl_easy_cleanup(handle); }
    HttpClient(const HttpClient&) = delete;
    HttpClient& operator=(const HttpClient&) = delete;

    struct Response {
        long code = 0;
        std::string body;
    };

    Response request(const std::string& method,
                     const std::string& url,
                     const std::string& body,
                     bool send_csrf) {
        Response r;
        curl_easy_setopt(handle, CURLOPT_URL, url.c_str());
        curl_easy_setopt(handle, CURLOPT_WRITEDATA, &r.body);
        r.body.clear();

        curl_slist* headers = nullptr;
        if (method != "GET") {
            headers = curl_slist_append(headers, "Content-Type: application/json");
        }
        std::string csrf_hdr;
        if (send_csrf && !csrf.empty()) {
            csrf_hdr = "X-CSRF-Token: " + csrf;
            headers = curl_slist_append(headers, csrf_hdr.c_str());
        }
        curl_easy_setopt(handle, CURLOPT_HTTPHEADER, headers);

        if (method == "GET") {
            curl_easy_setopt(handle, CURLOPT_HTTPGET, 1L);
            curl_easy_setopt(handle, CURLOPT_POSTFIELDS, nullptr);
            curl_easy_setopt(handle, CURLOPT_POSTFIELDSIZE, 0L);
        } else {
            curl_easy_setopt(handle, CURLOPT_CUSTOMREQUEST, method.c_str());
            curl_easy_setopt(handle, CURLOPT_POSTFIELDS, body.c_str());
            curl_easy_setopt(handle, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
        }

        CURLcode rc = curl_easy_perform(handle);
        curl_slist_free_all(headers);
        // Restore method to a clean state for the next call.
        curl_easy_setopt(handle, CURLOPT_CUSTOMREQUEST, nullptr);

        if (rc != CURLE_OK) {
            throw std::runtime_error(std::string("HTTP transport: ") + curl_easy_strerror(rc));
        }
        curl_easy_getinfo(handle, CURLINFO_RESPONSE_CODE, &r.code);
        return r;
    }
};

std::string http_error_message(const std::string& body) {
    try {
        auto j = json::parse(body);
        if (j.is_object() && j.contains("error") && j["error"].is_string()) {
            return j["error"].get<std::string>();
        }
    } catch (...) {}
    return body;
}

// ---------- API calls ----------

void do_login(HttpClient& hc, const std::string& server,
              const std::string& user, const std::string& pass) {
    json body = {{"username", user}, {"password", pass}};
    auto r = hc.request("POST", server + "/api/login", body.dump(), false);
    if (r.code != 200) {
        throw std::runtime_error("HTTP " + std::to_string(r.code) + ": " + http_error_message(r.body));
    }
    auto j = json::parse(r.body);
    if (!j.contains("csrf_token") || !j["csrf_token"].is_string()) {
        throw std::runtime_error("no csrf_token in login response");
    }
    hc.csrf = j["csrf_token"].get<std::string>();
    if (hc.csrf.empty()) throw std::runtime_error("empty csrf_token in login response");
}

struct Contest {
    int64_t id = 0;
    std::string name;
    std::string station_call;
    std::string status;
};

std::vector<Contest> get_contests(HttpClient& hc, const std::string& server) {
    auto r = hc.request("GET", server + "/api/contests", {}, false);
    if (r.code != 200) {
        throw std::runtime_error("HTTP " + std::to_string(r.code) + ": " + http_error_message(r.body));
    }
    std::vector<Contest> out;
    auto arr = json::parse(r.body);
    for (auto& c : arr) {
        Contest x;
        x.id           = c.value("id", int64_t{0});
        x.name         = c.value("name", "");
        x.station_call = c.value("station_call", "");
        x.status       = c.value("status", "");
        out.push_back(std::move(x));
    }
    return out;
}

int64_t pick_contest(const std::vector<Contest>& contests) {
    std::cout << "\nAvailable contests:\n";
    for (size_t i = 0; i < contests.size(); ++i) {
        std::cout << "  [" << (i + 1) << "] " << contests[i].name
                  << "  (" << contests[i].station_call << ")  status: "
                  << contests[i].status << "\n";
    }
    for (;;) {
        std::cout << "Select contest [1]: " << std::flush;
        std::string line;
        if (!std::getline(std::cin, line)) return contests[0].id;
        // trim
        while (!line.empty() && std::isspace(static_cast<unsigned char>(line.back()))) line.pop_back();
        size_t s = 0; while (s < line.size() && std::isspace(static_cast<unsigned char>(line[s]))) ++s;
        line.erase(0, s);
        if (line.empty()) return contests[0].id;
        try {
            int n = std::stoi(line);
            if (n >= 1 && n <= static_cast<int>(contests.size())) {
                return contests[n - 1].id;
            }
        } catch (...) {}
        std::cout << "  please enter a number between 1 and " << contests.size() << "\n";
    }
}

void select_contest(HttpClient& hc, const std::string& server, int64_t id) {
    std::string url = server + "/api/contests/" + std::to_string(id) + "/select";
    auto r = hc.request("POST", url, "{}", true);
    if (r.code != 200) {
        throw std::runtime_error("HTTP " + std::to_string(r.code) + ": " + http_error_message(r.body));
    }
}

// ---------- UDP listener ----------

// Parse "host:port" into (host, port). host may be empty ("").
std::pair<std::string, uint16_t> split_hostport(const std::string& hp) {
    auto pos = hp.rfind(':');
    if (pos == std::string::npos) throw std::runtime_error("bad host:port: " + hp);
    return {hp.substr(0, pos), static_cast<uint16_t>(std::stoi(hp.substr(pos + 1)))};
}

int listen_udp(const std::string& addr) {
    auto [host, port] = split_hostport(addr);
    if (host.empty()) host = "0.0.0.0";

    in_addr ip{};
    if (inet_pton(AF_INET, host.c_str(), &ip) != 1) {
        throw std::runtime_error("bad IPv4 in -udp: " + host);
    }
    bool is_multicast = (ntohl(ip.s_addr) & 0xF0000000u) == 0xE0000000u; // 224.0.0.0/4

    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) throw std::runtime_error("socket: " + std::string(strerror(errno)));

    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
#ifdef SO_REUSEPORT
    setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
#endif

    sockaddr_in bind_addr{};
    bind_addr.sin_family = AF_INET;
    bind_addr.sin_port   = htons(port);
    // For multicast, bind to the group so we only receive its traffic
    // (matches Go's net.ListenMulticastUDP semantics on Linux).
    bind_addr.sin_addr   = is_multicast ? ip : in_addr{INADDR_ANY};

    if (bind(fd, reinterpret_cast<sockaddr*>(&bind_addr), sizeof(bind_addr)) < 0) {
        int e = errno; close(fd);
        throw std::runtime_error("bind " + addr + ": " + strerror(e));
    }

    if (is_multicast) {
        ip_mreq mreq{};
        mreq.imr_multiaddr = ip;
        mreq.imr_interface.s_addr = htonl(INADDR_ANY);
        if (setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq)) < 0) {
            int e = errno; close(fd);
            throw std::runtime_error("join multicast " + host + ": " + strerror(e));
        }
    }
    return fd;
}

// ---------- WSJT-X binary protocol ----------

struct Reader {
    const uint8_t* p;
    const uint8_t* end;
    Reader(const uint8_t* d, size_t n) : p(d), end(d + n) {}
    bool have(size_t n) const { return static_cast<size_t>(end - p) >= n; }
    uint32_t u32() {
        if (!have(4)) throw std::runtime_error("truncated u32");
        uint32_t v = (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
                     (uint32_t(p[2]) <<  8) |  uint32_t(p[3]);
        p += 4;
        return v;
    }
    uint64_t u64() {
        if (!have(8)) throw std::runtime_error("truncated u64");
        uint64_t v = 0;
        for (int i = 0; i < 8; ++i) v = (v << 8) | p[i];
        p += 8;
        return v;
    }
    uint8_t u8() {
        if (!have(1)) throw std::runtime_error("truncated u8");
        return *p++;
    }
    std::string str() {
        uint32_t n = u32();
        if (n == 0 || n == 0xFFFFFFFFu) return {};
        if (!have(n)) throw std::runtime_error("truncated string");
        std::string s(reinterpret_cast<const char*>(p), n);
        p += n;
        return s;
    }
    // QDateTime: uint64 Julian day + uint32 ms-since-midnight + uint8 spec.
    // Returns Unix-epoch time in seconds; 0 if the QDateTime is zero.
    std::pair<time_t, int> qdatetime() {
        uint64_t jd = u64();
        uint32_t ms = u32();
        (void)u8();  // timeSpec, ignored (Go code ignores it too)
        if (jd == 0 && ms == 0) return {0, 0};
        int64_t sec = (int64_t(jd) - kJulianEpoch) * 86400 + int64_t(ms) / 1000;
        int ns_frac = int(ms % 1000) * 1'000'000;
        return {static_cast<time_t>(sec), ns_frac};
    }
};

struct LogQSO {
    time_t   dt_off_sec = 0;
    time_t   dt_on_sec  = 0;
    std::string dx_call;
    std::string dx_grid;
    uint64_t dial_freq = 0;
    std::string mode;
    std::string report_sent;
    std::string report_received;
    std::string tx_power;
    std::string comments;
    std::string name;
    std::string operator_call;
    std::string my_call;
    std::string my_grid;
    std::string exchange_sent;
    std::string exchange_received;
};

std::optional<LogQSO> parse_log_qso(const uint8_t* data, size_t n) {
    try {
        Reader r(data, n);
        if (r.u32() != kWsjtxMagic) return std::nullopt;
        (void)r.u32();  // schema
        if (r.u32() != kMsgLogQSO) return std::nullopt;
        (void)r.str();  // client id

        LogQSO m;
        m.dt_off_sec        = r.qdatetime().first;
        m.dx_call           = r.str();
        m.dx_grid           = r.str();
        m.dial_freq         = r.u64();
        m.mode              = r.str();
        m.report_sent       = r.str();
        m.report_received   = r.str();
        m.tx_power          = r.str();
        m.comments          = r.str();
        m.name              = r.str();
        m.dt_on_sec         = r.qdatetime().first;
        m.operator_call     = r.str();
        m.my_call           = r.str();
        m.my_grid           = r.str();
        m.exchange_sent     = r.str();
        m.exchange_received = r.str();
        // schema >= 3 appends AdifPropagationMode; ignore trailing bytes.

        if (m.dx_call.empty()) return std::nullopt;
        return m;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

// ---------- QSO submission ----------

std::string to_upper(std::string s) {
    for (auto& c : s) c = std::toupper(static_cast<unsigned char>(c));
    return s;
}

std::string trim(std::string s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
    return s.substr(a, b - a);
}

// Format a time_t (assumed UTC) as RFC3339, matching Go's time.RFC3339 output.
std::string format_rfc3339_utc(time_t t) {
    tm g{};
    gmtime_r(&t, &g);
    std::ostringstream ss;
    ss << std::put_time(&g, "%Y-%m-%dT%H:%M:%SZ");
    return ss.str();
}

void submit_qso(HttpClient& hc, const std::string& server,
                const LogQSO& m, bool force_dup) {
    time_t t = m.dt_on_sec != 0 ? m.dt_on_sec : m.dt_off_sec;
    std::string notes = trim(m.name + " " + m.comments);

    json payload = {
        {"callsign",     to_upper(trim(m.dx_call))},
        {"freq_hz",      static_cast<int64_t>(m.dial_freq)},
        {"mode",         m.mode},
        {"rst_sent",     trim(m.report_sent)},
        {"rst_received", trim(m.report_received)},
        {"locator",      to_upper(trim(m.dx_grid))},
        {"time",         format_rfc3339_utc(t)},
    };
    if (!notes.empty()) payload["notes"] = notes;

    std::string url = server + "/api/qsos";
    if (force_dup) url += "?force=1";

    auto r = hc.request("POST", url, payload.dump(), true);
    if (r.code == 201) return;
    if (r.code == 409) {
        throw std::runtime_error("possible duplicate (use -force-dup to override)");
    }
    throw std::runtime_error("HTTP " + std::to_string(r.code) + ": " + http_error_message(r.body));
}

// Left-pad string to width `w` with spaces. Used for log alignment.
std::string ljust(const std::string& s, size_t w) {
    if (s.size() >= w) return s;
    return s + std::string(w - s.size(), ' ');
}

// Prefix log lines with "YYYY/MM/DD HH:MM:SS " to match Go's default log format.
void log_line(const std::string& msg) {
    auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    tm g{};
    localtime_r(&now, &g);
    char buf[64];
    std::strftime(buf, sizeof buf, "%Y/%m/%d %H:%M:%S", &g);
    std::cerr << buf << " " << msg << "\n";
}

}  // namespace

int main(int argc, char** argv) {
    Args a;
    try {
        a = parse_args(argc, argv);
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 2;
    }

    if (a.user.empty()) {
        std::cerr << "error: -user is required\n";
        usage(2);
    }

    // Default to https:// if the user gave a bare host:port with no scheme.
    if (a.server.rfind("http://", 0) != 0 && a.server.rfind("https://", 0) != 0) {
        a.server = "https://" + a.server;
    }

    if (!a.pass_set) a.pass = prompt_password();

    curl_global_init(CURL_GLOBAL_DEFAULT);

    try {
        HttpClient hc;
        do_login(hc, a.server, a.user, a.pass);
        log_line("logged in as " + a.user);

        auto contests = get_contests(hc, a.server);
        if (contests.empty()) {
            log_line("no contests found on server — create one first via the web UI");
            curl_global_cleanup();
            return 1;
        }
        int64_t id = pick_contest(contests);
        select_contest(hc, a.server, id);
        log_line("contest selected; listening for WSJT-X on " + a.udp);

        int fd = listen_udp(a.udp);
        std::vector<uint8_t> buf(65535);
        for (;;) {
            ssize_t n = recv(fd, buf.data(), buf.size(), 0);
            if (n < 0) {
                log_line(std::string("udp read: ") + strerror(errno));
                continue;
            }
            auto msg = parse_log_qso(buf.data(), static_cast<size_t>(n));
            if (!msg) continue;
            try {
                submit_qso(hc, a.server, *msg, a.force_dup);
                log_line("logged: " + ljust(msg->dx_call, 12) + "  " + ljust(msg->mode, 8) +
                         "  sent=" + ljust(msg->report_sent, 4) + "  rcvd=" + msg->report_received);
            } catch (const std::exception& e) {
                log_line("submit " + msg->dx_call + ": " + e.what());
            }
        }
    } catch (const std::exception& e) {
        log_line(std::string("fatal: ") + e.what());
        curl_global_cleanup();
        return 1;
    }
}
