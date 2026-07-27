#include "credentials.hpp"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStandardPaths>

#ifdef Q_OS_UNIX
#include <sys/stat.h>
#endif

namespace {

// Container directory for our config.  We deliberately don't reuse the
// full QStandardPaths::AppConfigLocation (which appends the app name a
// second time) — instead we drop straight into "Noctalum/" so the CLI
// helper and the various C++/Go GUIs share one namespace per platform.
//
// Per-OS layout:
//   Linux:   $XDG_CONFIG_HOME (or ~/.config) → GenericConfigLocation
//   macOS:   ~/Library/Application Support   → GenericDataLocation
//            (GenericConfigLocation on macOS is ~/Library/Preferences,
//             which is reserved for plists — we want a JSON file.)
//   Windows: %APPDATA%                       → GenericConfigLocation
QString configDir() {
#ifdef Q_OS_MAC
    QString base = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
#else
    QString base = QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation);
#endif
    if (base.isEmpty()) base = QDir::homePath() + "/.config";
    return base + "/Noctalum";
}

QString filePath() { return configDir() + "/wsjtx-bridge.json"; }

// mkdir -p that additionally locks the directory down to the owner on POSIX.
void ensureDir(const QString& dir) {
    QDir().mkpath(dir);
#ifdef Q_OS_UNIX
    ::chmod(QFile::encodeName(dir).constData(), 0700);
#endif
}

}  // namespace

QString CredentialStore::path() { return filePath(); }

Credentials CredentialStore::load() {
    QFile f(filePath());
    if (!f.open(QIODevice::ReadOnly)) return {};
    auto doc = QJsonDocument::fromJson(f.readAll());
    if (!doc.isObject()) return {};
    QJsonObject o = doc.object();
    Credentials c;
    c.server        = o.value("server").toString();
    c.user          = o.value("user").toString();
    c.pass          = o.value("pass").toString();
    c.udp           = o.value("udp").toString();
    c.rememberPass  = o.value("remember_pass").toBool();
    c.forceDup      = o.value("force_dup").toBool();
    c.authMode      = o.value("auth_mode").toString();
    c.token         = o.value("token").toString();
    c.rememberToken = o.value("remember_token").toBool();
    // Guard against a stale password/token left behind by a store that was
    // written before the corresponding "remember" flag was flipped off
    // out-of-band.
    if (!c.rememberPass)  c.pass.clear();
    if (!c.rememberToken) c.token.clear();
    return c;
}

void CredentialStore::save(const Credentials& c) {
    ensureDir(configDir());
    QJsonObject o;
    o["server"]         = c.server;
    o["user"]           = c.user;
    o["pass"]           = c.rememberPass  ? c.pass  : QString();
    o["udp"]            = c.udp;
    o["remember_pass"]  = c.rememberPass;
    o["force_dup"]      = c.forceDup;
    o["auth_mode"]      = c.authMode;
    o["token"]          = c.rememberToken ? c.token : QString();
    o["remember_token"] = c.rememberToken;

    QFile f(filePath());
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
    f.write(QJsonDocument(o).toJson(QJsonDocument::Indented));
    f.close();
#ifdef Q_OS_UNIX
    ::chmod(QFile::encodeName(filePath()).constData(), 0600);
#endif
}

void CredentialStore::clear() {
    QFile::remove(filePath());
}
