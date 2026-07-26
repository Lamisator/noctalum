#include "rigctld_client.hpp"

#include <QDeadlineTimer>
#include <QElapsedTimer>
#include <QTcpServer>
#include <QTcpSocket>
#include <QThread>
#include <sys/socket.h>

static QString rprt_message(const QString& code) {
    if (code == "-5") return "rig not responding";
    if (code == "-9") return "rig timeout";
    return "rig error (RPRT " + code + ")";
}

QString rig_query(const QString& host, int port, const QString& cmd, int timeout_ms) {
    QTcpSocket sock;
    sock.connectToHost(host, static_cast<quint16>(port));
    if (!sock.waitForConnected(2000)) throw RigError("cannot reach rigctld");

    QByteArray tx = (cmd + "\n").toUtf8();
    if (sock.write(tx) < 0 || !sock.waitForBytesWritten(timeout_ms)) {
        throw RigError("rigctld write failed");
    }
    // Half-close write side.  QTcpSocket doesn't expose this cleanly, so we
    // reach for the underlying fd — matches nc's behaviour: rigctld flushes
    // its response as soon as it sees FIN.
    ::shutdown(sock.socketDescriptor(), SHUT_WR);

    QByteArray acc;
    QDeadlineTimer deadline(timeout_ms);
    while (!deadline.hasExpired()) {
        if (!sock.waitForReadyRead(std::min<int>(200, deadline.remainingTime()))) {
            if (sock.state() != QAbstractSocket::ConnectedState) break;
            continue;
        }
        acc += sock.readAll();
        // Stop early if we already have "RPRT ..." followed by a newline.
        if (acc.contains("RPRT ")) break;
    }
    acc = acc.trimmed();

    // Locate the last "RPRT <code>" line and split.
    int nl = acc.lastIndexOf('\n');
    QByteArray last = (nl < 0) ? acc : acc.mid(nl + 1);
    if (last.startsWith("RPRT ")) {
        QString code = QString::fromLatin1(last.mid(5)).trimmed();
        if (code != "0") throw RigError(rprt_message(code).toStdString());
        return (nl < 0) ? QString() : QString::fromUtf8(acc.left(nl));
    }
    return QString::fromUtf8(acc);
}

RigState read_rig(const QString& host, int port) {
    RigState st;
    auto f = rig_query(host, port, "f");
    auto first = f.section('\n', 0, 0).trimmed();
    bool ok = false;
    st.freq_hz = first.toLongLong(&ok);
    if (!ok) throw RigError("rig returned invalid frequency");
    try {
        auto m = rig_query(host, port, "m");
        st.mode = m.section('\n', 0, 0).trimmed();
    } catch (const RigError&) { st.mode.clear(); }
    return st;
}

void set_rig_freq(const QString& host, int port, int64_t freq_hz) {
    rig_query(host, port, "F " + QString::number(freq_hz));
}
void set_rig_mode(const QString& host, int port, const QString& mode) {
    rig_query(host, port, "M " + mode + " 0");
}

int find_free_port() {
    QTcpServer s;
    if (!s.listen(QHostAddress::LocalHost, 0)) return -1;
    int p = s.serverPort();
    s.close();
    return p;
}

bool wait_for_rigctld(const QString& host, int port, int timeout_ms) {
    QDeadlineTimer deadline(timeout_ms);
    while (!deadline.hasExpired()) {
        QTcpSocket sock;
        sock.connectToHost(host, static_cast<quint16>(port));
        if (sock.waitForConnected(500)) return true;
        QThread::msleep(100);
    }
    return false;
}
