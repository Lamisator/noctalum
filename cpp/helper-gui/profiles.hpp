#pragma once

#include "types.hpp"
#include <QString>

// XDG-aware profile store, JSON-compatible with cmd/helper-gui/profiles.go
// and the CLI helper's shared store.  All operations are best-effort — on I/O
// failure they return the state we had, mirroring Go's ignore-errors approach.

class Profiles {
public:
    // Read the shared store from
    // $XDG_CONFIG_HOME/noctalum/noctalum-helper-gui.json, falling back to the
    // legacy $XDG_CONFIG_HOME/contestlog/contestlog-helper-gui.json.  Returns
    // an empty store if neither exists.
    static ProfileStore load();

    // Save the whole store to the current path.  Creates the parent dir with
    // mode 0700 and writes the file with mode 0600.
    static void save(const ProfileStore& s);

    // Upsert a profile by name and mark it as last-used.  Returns the updated store.
    static ProfileStore upsert(const Profile& p);

    // Remove a profile by name.  Clears last_used if it referenced the deletion.
    static ProfileStore remove(const QString& name);

    // Update only last_used without touching profile bodies.
    static void set_last(const QString& name);

    // Absolute path to the primary JSON file (may not exist yet).
    static QString path();
};
