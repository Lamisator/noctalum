#include "util.hpp"

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstring>
#include <glob.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

namespace nhelper {

std::vector<std::string> detect_serial_ports() {
    std::vector<std::string> out;
    for (const char* pat : {"/dev/ttyUSB*", "/dev/ttyACM*"}) {
        glob_t g{};
        if (glob(pat, 0, nullptr, &g) == 0) {
            for (size_t i = 0; i < g.gl_pathc; ++i) out.emplace_back(g.gl_pathv[i]);
        }
        globfree(&g);
    }
    std::sort(out.begin(), out.end());
    out.erase(std::unique(out.begin(), out.end()), out.end());
    return out;
}

std::string default_rigctld_bin() {
    // PATH lookup for "rigctld".
    const char* path = std::getenv("PATH");
    if (path) {
        std::string p = path;
        size_t start = 0;
        while (start <= p.size()) {
            size_t sep = p.find(':', start);
            std::string dir = p.substr(start, sep == std::string::npos ? std::string::npos : sep - start);
            if (!dir.empty()) {
                std::string cand = dir + "/rigctld";
                struct stat st{};
                if (stat(cand.c_str(), &st) == 0 && (st.st_mode & S_IXUSR)) return cand;
            }
            if (sep == std::string::npos) break;
            start = sep + 1;
        }
    }
    return "rigctld";
}

std::string to_rigctld_mode(const std::string& mode, int64_t freq_hz) {
    std::string m = mode;
    std::transform(m.begin(), m.end(), m.begin(),
                   [](unsigned char c) { return std::toupper(c); });
    if (m == "CW" || m == "USB" || m == "LSB" || m == "FM" || m == "AM" || m == "RTTY") return m;
    if (m == "SSB") return (freq_hz > 0 && freq_hz < 10'000'000) ? "LSB" : "USB";
    if (m == "FT8" || m == "FT4" || m == "PSK31" || m == "PSK63" || m == "JT65" || m == "DIGI") return "USB";
    return {};
}

std::string trim(std::string s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
    return s.substr(a, b - a);
}

int find_free_port() {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sa.sin_port = 0;
    if (bind(fd, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) < 0) { close(fd); return -1; }
    socklen_t sl = sizeof(sa);
    if (getsockname(fd, reinterpret_cast<sockaddr*>(&sa), &sl) < 0) { close(fd); return -1; }
    int port = ntohs(sa.sin_port);
    close(fd);
    return port;
}

}  // namespace nhelper
