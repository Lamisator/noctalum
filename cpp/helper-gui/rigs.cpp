#include "rigs.hpp"

#include <QProcess>
#include <QRegularExpression>
#include <algorithm>

QVector<RigPreset> curated_rigs() {
    // Kept in sync with cmd/helper-gui/rigs.go — same order, same defaults.
    return {
        {"IC-7300",       3073, 19200,  "Icom"},
        {"IC-705",        3085,  9600,  "Icom"},
        {"IC-9700",       3081, 19200,  "Icom"},
        {"IC-7100",       3061,  9600,  "Icom"},
        {"IC-7610",       3068, 19200,  "Icom"},
        {"IC-7200",       3062, 19200,  "Icom"},
        {"IC-7000",       3071, 19200,  "Icom"},
        {"FT-991/A",      1040, 38400,  "Yaesu"},
        {"FT-DX10",       1042, 38400,  "Yaesu"},
        {"FTdx101D/MP",   1041, 38400,  "Yaesu"},
        {"FT-450/D",      1039,  4800,  "Yaesu"},
        {"FT-857",        1018,  4800,  "Yaesu"},
        {"FT-897",        1020,  4800,  "Yaesu"},
        {"TS-590S",       2014,  9600,  "Kenwood"},
        {"TS-590SG",      2027,  9600,  "Kenwood"},
        {"TS-890S",       2028, 115200, "Kenwood"},
        {"TS-2000",       2042,  9600,  "Kenwood"},
    };
}

// Parse one line of `rigctld -l` output into a RigPreset.  Returns model=0
// on failure so callers can drop the entry.  Format across Hamlib 4.5–4.7:
//     " Rig #   Mfg               Model                     Version         ..."
//     "  3073   Icom              IC-7300                   20240624.0      ..."
//
// The model number is always the first whitespace-delimited token; the
// vendor + label follow, but "label" can contain spaces.  Simple heuristic:
// tokenize, first token = model, second = vendor, everything up to the next
// obvious version-like token = label.
static RigPreset parse_rig_line(const QString& line) {
    RigPreset out;
    auto stripped = line.trimmed();
    if (stripped.isEmpty() || !stripped[0].isDigit()) return out;
    auto parts = stripped.split(QRegularExpression("\\s{2,}"), Qt::SkipEmptyParts);
    if (parts.size() < 3) return out;
    bool ok = false;
    out.model = parts[0].toInt(&ok);
    if (!ok || out.model == 0) return out;
    out.vendor = parts[1].trimmed();
    out.label  = parts[2].trimmed();
    // defaultSpeed is unknown from rigctld -l output; leave as 0.
    return out;
}

QVector<RigPreset> all_rigs(const QString& rigctld_bin) {
    QProcess proc;
    proc.setProcessChannelMode(QProcess::MergedChannels);
    proc.start(rigctld_bin.isEmpty() ? QString("rigctld") : rigctld_bin, {"-l"});
    if (!proc.waitForStarted(3000) || !proc.waitForFinished(5000)) {
        return curated_rigs();
    }
    auto out = QString::fromLocal8Bit(proc.readAllStandardOutput());
    QVector<RigPreset> rigs;
    for (const auto& line : out.split('\n')) {
        auto r = parse_rig_line(line);
        if (r.model == 0) continue;
        // Skip software / test rigs — they'd waste time during auto-scan.
        if (r.vendor.compare("Hamlib", Qt::CaseInsensitive) == 0) continue;
        auto lbl = r.label.toLower();
        if (lbl.contains("dummy") || lbl.contains("demo") || lbl.contains("net rigctl")) continue;
        rigs.append(r);
    }
    if (rigs.isEmpty()) return curated_rigs();

    // Merge: curated speed hints override rigctld -l entries when the model matches.
    for (auto& r : rigs) {
        for (const auto& c : curated_rigs()) {
            if (c.model == r.model) { r.defaultSpeed = c.defaultSpeed; break; }
        }
    }
    std::sort(rigs.begin(), rigs.end(), [](const RigPreset& a, const RigPreset& b) {
        if (a.vendor != b.vendor) return a.vendor < b.vendor;
        return a.label < b.label;
    });
    return rigs;
}
