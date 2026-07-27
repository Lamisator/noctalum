#include "wsjtx_protocol.hpp"

#include <cstring>

namespace {

constexpr quint32 kWsjtxMagic  = 0xADBCCBDAu;
constexpr quint32 kMsgLogQSO   = 5u;
constexpr qint64  kJulianEpoch = 2440588;  // Julian day of 1970-01-01

// Big-endian reader over a byte span.  Throws on truncation so the caller
// can just wrap the whole parse in a try/catch — matches the layout of the
// Go reference implementation in cmd/wsjtx.
class Reader {
public:
    Reader(const uchar* p, qsizetype n) : p_(p), end_(p + n) {}

    bool have(qsizetype n) const { return (end_ - p_) >= n; }

    quint32 u32() {
        if (!have(4)) throw std::runtime_error("truncated u32");
        quint32 v = (quint32(p_[0]) << 24) | (quint32(p_[1]) << 16) |
                    (quint32(p_[2]) <<  8) |  quint32(p_[3]);
        p_ += 4;
        return v;
    }
    quint64 u64() {
        if (!have(8)) throw std::runtime_error("truncated u64");
        quint64 v = 0;
        for (int i = 0; i < 8; ++i) v = (v << 8) | p_[i];
        p_ += 8;
        return v;
    }
    quint8 u8() {
        if (!have(1)) throw std::runtime_error("truncated u8");
        return *p_++;
    }
    QString qtStr() {
        quint32 n = u32();
        // WSJT-X uses QString serialisation: 0xFFFFFFFF marks a null string,
        // 0 marks an empty string, both fine as empty on our side.
        if (n == 0 || n == 0xFFFFFFFFu) return {};
        if (!have(n)) throw std::runtime_error("truncated string");
        QString s = QString::fromUtf8(reinterpret_cast<const char*>(p_),
                                      static_cast<int>(n));
        p_ += n;
        return s;
    }
    // QDateTime is jd:u64 + msSinceMidnight:u32 + timeSpec:u8.  Returns the
    // Unix timestamp in seconds; 0 for the "null" QDateTime.
    qint64 qDateTimeSec() {
        quint64 jd = u64();
        quint32 ms = u32();
        (void)u8();   // timeSpec, ignored (matches the Go bridge)
        if (jd == 0 && ms == 0) return 0;
        return (qint64(jd) - kJulianEpoch) * 86400 + qint64(ms) / 1000;
    }

private:
    const uchar* p_;
    const uchar* end_;
};

QString upper(QString s) { return s.toUpper(); }

QString joinNotes(const QString& name, const QString& comments) {
    QString a = name.trimmed(), b = comments.trimmed();
    if (a.isEmpty()) return b;
    if (b.isEmpty()) return a;
    return a + " " + b;
}

}  // namespace

std::optional<LogQSO> parseLogQso(const QByteArray& data) {
    try {
        Reader r(reinterpret_cast<const uchar*>(data.constData()), data.size());
        if (r.u32() != kWsjtxMagic) return std::nullopt;
        (void)r.u32();     // schema version, tolerated as-is
        if (r.u32() != kMsgLogQSO) return std::nullopt;
        (void)r.qtStr();   // client id, ignored

        LogQSO m;
        qint64  dtOff        = r.qDateTimeSec();
        QString dxCall       = r.qtStr();
        QString dxGrid       = r.qtStr();
        quint64 dialFreq     = r.u64();
        QString mode         = r.qtStr();
        QString reportSent   = r.qtStr();
        QString reportRcvd   = r.qtStr();
        (void)r.qtStr();   // tx_power, ignored
        QString comments     = r.qtStr();
        QString name         = r.qtStr();
        qint64  dtOn         = r.qDateTimeSec();
        // Remaining fields (operator_call, my_call, my_grid, exchange_sent,
        // exchange_received, and — schema >= 3 — AdifPropagationMode) are
        // parsed by the CLI bridge but not needed by the server.

        if (dxCall.isEmpty()) return std::nullopt;
        m.timeSec      = dtOn != 0 ? dtOn : dtOff;
        m.call         = upper(dxCall.trimmed());
        m.grid         = upper(dxGrid.trimmed());
        m.freqHz       = dialFreq;
        m.mode         = mode;
        m.rstSent      = reportSent.trimmed();
        m.rstReceived  = reportRcvd.trimmed();
        m.notes        = joinNotes(name, comments);
        return m;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}
