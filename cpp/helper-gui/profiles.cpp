#include "profiles.hpp"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStandardPaths>
#include <sys/stat.h>

static QString noctalum_dir() {
    QString xdg = QString::fromLocal8Bit(qgetenv("XDG_CONFIG_HOME"));
    if (xdg.isEmpty()) xdg = QDir::homePath() + "/.config";
    return xdg + "/noctalum";
}

static QString legacy_dir() {
    QString xdg = QString::fromLocal8Bit(qgetenv("XDG_CONFIG_HOME"));
    if (xdg.isEmpty()) xdg = QDir::homePath() + "/.config";
    return xdg + "/contestlog";
}

QString Profiles::path() {
    return noctalum_dir() + "/noctalum-helper-gui.json";
}

static Profile from_json(const QJsonObject& o) {
    Profile p;
    p.name             = o.value("name").toString();
    p.server           = o.value("server").toString();
    p.token            = o.value("token").toString();
    p.rigName          = o.value("rig_name").toString();
    p.rigModel         = o.value("rig_model").toInt();
    p.rigDevice        = o.value("rig_device").toString();
    p.rigSpeed         = o.value("rig_speed").toInt();
    p.rigctldBin       = o.value("rigctld_bin").toString();
    p.intervalMs       = o.value("interval_ms").toInt(1000);
    p.autoDetect       = o.value("auto_detect").toBool();
    p.autoDetectModel  = o.value("auto_detect_model").toBool();
    return p;
}

static QJsonObject to_json(const Profile& p) {
    QJsonObject o;
    o["name"]              = p.name;
    o["server"]            = p.server;
    o["token"]             = p.token;
    o["rig_name"]          = p.rigName;
    o["rig_model"]         = p.rigModel;
    o["rig_device"]        = p.rigDevice;
    o["rig_speed"]         = p.rigSpeed;
    o["rigctld_bin"]       = p.rigctldBin;
    o["interval_ms"]       = p.intervalMs;
    o["auto_detect"]       = p.autoDetect;
    o["auto_detect_model"] = p.autoDetectModel;
    return o;
}

static ProfileStore parse_store(const QByteArray& data) {
    ProfileStore s;
    auto doc = QJsonDocument::fromJson(data);
    if (!doc.isObject()) return s;
    auto obj = doc.object();
    for (auto v : obj.value("profiles").toArray()) s.profiles.append(from_json(v.toObject()));
    s.lastUsed = obj.value("last_used").toString();
    return s;
}

ProfileStore Profiles::load() {
    for (const QString& p : {path(), legacy_dir() + "/contestlog-helper-gui.json"}) {
        QFile f(p);
        if (f.open(QIODevice::ReadOnly)) {
            auto data = f.readAll();
            if (!data.isEmpty()) return parse_store(data);
        }
    }
    return {};
}

// mkdir -p equivalent that sets mode 0700 on newly-created dirs, matching Go.
static void mkpath_secure(const QString& dir) {
    QDir().mkpath(dir);
    ::chmod(QFile::encodeName(dir).constData(), 0700);
}

void Profiles::save(const ProfileStore& s) {
    QJsonArray arr;
    for (const auto& p : s.profiles) arr.append(to_json(p));
    QJsonObject root;
    root["profiles"]  = arr;
    root["last_used"] = s.lastUsed;

    QString file = path();
    mkpath_secure(QFileInfo(file).absolutePath());

    QFile f(file);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
    f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    f.close();
    ::chmod(QFile::encodeName(file).constData(), 0600);
}

ProfileStore Profiles::upsert(const Profile& p) {
    ProfileStore s = load();
    bool replaced = false;
    for (auto& q : s.profiles) {
        if (q.name == p.name) { q = p; replaced = true; break; }
    }
    if (!replaced) s.profiles.append(p);
    s.lastUsed = p.name;
    save(s);
    return s;
}

ProfileStore Profiles::remove(const QString& name) {
    ProfileStore s = load();
    s.profiles.erase(std::remove_if(s.profiles.begin(), s.profiles.end(),
        [&](const Profile& p) { return p.name == name; }), s.profiles.end());
    if (s.lastUsed == name) s.lastUsed.clear();
    save(s);
    return s;
}

void Profiles::set_last(const QString& name) {
    ProfileStore s = load();
    s.lastUsed = name;
    save(s);
}
