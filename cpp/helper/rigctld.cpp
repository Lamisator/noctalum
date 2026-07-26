#include "rigctld.hpp"
#include "common.hpp"

#include <arpa/inet.h>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <string>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace nhelper {

// Dial host:port with a 2 s timeout.  Returns fd, or -1 on failure with errno set.
static int tcp_dial(const std::string& host, int port, int timeout_ms = 2000) {
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    std::string port_s = std::to_string(port);
    if (getaddrinfo(host.c_str(), port_s.c_str(), &hints, &res) != 0) {
        errno = ENOENT;
        return -1;
    }
    int fd = -1;
    for (addrinfo* p = res; p; p = p->ai_next) {
        fd = socket(p->ai_family, p->ai_socktype | SOCK_NONBLOCK, p->ai_protocol);
        if (fd < 0) continue;
        int rc = connect(fd, p->ai_addr, p->ai_addrlen);
        if (rc == 0) break;
        if (errno != EINPROGRESS) { close(fd); fd = -1; continue; }
        // Wait for socket to become writable (= connected or errored).
        fd_set wr; FD_ZERO(&wr); FD_SET(fd, &wr);
        timeval tv{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
        int sel = select(fd + 1, nullptr, &wr, nullptr, &tv);
        if (sel <= 0) { close(fd); fd = -1; continue; }
        int so_err = 0; socklen_t sl = sizeof(so_err);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &so_err, &sl) < 0 || so_err != 0) {
            close(fd); fd = -1; continue;
        }
        break;
    }
    freeaddrinfo(res);
    if (fd >= 0) {
        // Return to blocking mode; individual reads set their own deadlines.
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
    }
    return fd;
}

// Set combined SO_RCVTIMEO/SO_SNDTIMEO so blocking read/write on fd time out.
static void set_deadline(int fd, int ms) {
    timeval tv{ms / 1000, (ms % 1000) * 1000};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
}

// Map a Hamlib RPRT code to a human message.  Codes we haven't special-cased
// pass through verbatim so operators can look them up in Hamlib docs.
static std::string rprt_message(const std::string& code) {
    if (code == "-5") return "rig not responding";
    if (code == "-9") return "rig timeout";
    return "rig error (RPRT " + code + ")";
}

std::string rig_query(const std::string& host, int port, const std::string& cmd) {
    int fd = tcp_dial(host, port);
    if (fd < 0) throw RigError("cannot reach rigctld");
    set_deadline(fd, 5000);

    std::string tx = cmd + "\n";
    ssize_t off = 0;
    while (off < static_cast<ssize_t>(tx.size())) {
        ssize_t n = send(fd, tx.data() + off, tx.size() - off, MSG_NOSIGNAL);
        if (n <= 0) { close(fd); throw RigError("rigctld write failed"); }
        off += n;
    }
    // Half-close write side — rigctld only flushes its response after seeing FIN,
    // matching the "printf cmd | nc host port" behaviour Go relies on.
    shutdown(fd, SHUT_WR);

    std::string acc;
    char buf[1024];
    for (;;) {
        ssize_t n = recv(fd, buf, sizeof(buf), 0);
        if (n < 0) {
            close(fd);
            if (errno == EAGAIN || errno == EWOULDBLOCK) throw RigError("rig not responding");
            throw RigError("rigctld read failed");
        }
        if (n == 0) break;   // remote closed — done
        acc.append(buf, n);
    }
    close(fd);

    // Split off trailing "RPRT N" line — that's rigctld's status footer.
    std::string body = acc;
    while (!body.empty() && (body.back() == '\r' || body.back() == '\n')) body.pop_back();
    auto nl = body.rfind('\n');
    std::string last = (nl == std::string::npos) ? body : body.substr(nl + 1);
    if (last.rfind("RPRT ", 0) == 0) {
        std::string code = last.substr(5);
        while (!code.empty() && std::isspace(static_cast<unsigned char>(code.back()))) code.pop_back();
        if (code != "0") throw RigError(rprt_message(code));
        return (nl == std::string::npos) ? std::string{} : body.substr(0, nl);
    }
    // No RPRT footer means either the daemon disconnected mid-response or
    // sent a non-standard reply.  Return what we got — the caller decides.
    return body;
}

RigState read_rig(const std::string& host, int port) {
    RigState st{};
    std::string f = rig_query(host, port, "f");
    // Freq is the first line; strip whitespace and parse.
    auto nl = f.find('\n');
    std::string first = (nl == std::string::npos) ? f : f.substr(0, nl);
    try { st.freq_hz = std::stoll(first); }
    catch (...) { throw RigError("rig returned invalid frequency"); }

    // Mode may fail silently (some rigs don't report it); mirror Go.
    try {
        std::string m = rig_query(host, port, "m");
        auto nl2 = m.find('\n');
        st.mode = (nl2 == std::string::npos) ? m : m.substr(0, nl2);
    } catch (const RigError&) { st.mode.clear(); }
    return st;
}

void set_rig_freq(const std::string& host, int port, int64_t freq_hz) {
    rig_query(host, port, "F " + std::to_string(freq_hz));
}
void set_rig_mode(const std::string& host, int port, const std::string& mode) {
    rig_query(host, port, "M " + mode + " 0");
}

bool wait_for_rigctld(const std::string& host, int port, std::chrono::seconds timeout) {
    auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        int fd = tcp_dial(host, port, 500);
        if (fd >= 0) { close(fd); return true; }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    return false;
}

int spawn_rigctld(const std::string& bin, int model, const std::string& device,
                  int speed, const std::string& host, int port) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        // Child.  Build argv and exec — rigctld writes to stderr so let it
        // inherit stderr/stdout from us; the operator sees them mixed with
        // helper logs, same as Go.
        std::vector<std::string> args;
        args.push_back(bin);
        args.push_back("-m"); args.push_back(std::to_string(model));
        args.push_back("-T"); args.push_back(host);
        args.push_back("-t"); args.push_back(std::to_string(port));
        if (!device.empty()) { args.push_back("-r"); args.push_back(device); }
        if (speed != 0)     { args.push_back("-s"); args.push_back(std::to_string(speed)); }
        std::vector<char*> argv;
        for (auto& s : args) argv.push_back(const_cast<char*>(s.c_str()));
        argv.push_back(nullptr);
        execvp(bin.c_str(), argv.data());
        std::_Exit(127);  // exec failed
    }
    return pid;
}

}  // namespace nhelper
