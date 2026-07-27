#pragma once

#include <QString>

// A single cached credential set.  The password is only present when the
// operator has explicitly asked for it to be remembered.
struct Credentials {
    QString server;
    QString user;
    QString pass;         // empty when the operator did not opt in
    QString udp;
    bool    rememberPass = false;
    bool    forceDup     = false;
};

// Small JSON-on-disk store, one file, cross-platform.  Placement mirrors the
// helper's Profile store:
//   Linux:   $XDG_CONFIG_HOME/noctalum/wsjtx-bridge.json  (fallback ~/.config)
//   macOS:   ~/Library/Application Support/Noctalum/wsjtx-bridge.json
//   Windows: %APPDATA%/Noctalum/wsjtx-bridge.json
//
// The file is written with owner-only permissions on POSIX (0600) so cached
// passwords don't leak via file-mode.  Windows relies on per-user ACLs on the
// AppData directory.
class CredentialStore {
public:
    // Read the store from disk.  Missing file → empty credentials.
    static Credentials load();

    // Persist `c`.  If rememberPass is false the password is stripped from
    // disk (but kept in memory for the current session).
    static void save(const Credentials& c);

    // Delete the on-disk file entirely.  Used by the "Forget saved
    // credentials" button.
    static void clear();

    // Absolute path we read/write.
    static QString path();
};
