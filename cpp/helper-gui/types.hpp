#pragma once

#include <QMetaType>
#include <QString>
#include <QVector>

// Plain-data records shared by the UI, session worker, and profile store.
// Field names mirror cmd/helper-gui's Go structs so the JSON on disk stays
// binary-identical to what the Go GUI produces.

struct RigPreset {
    QString label;
    int model = 0;
    int defaultSpeed = 0;
    QString vendor;
};

struct Profile {
    QString name;
    QString server;
    QString token;
    QString rigName;
    int     rigModel = 0;
    QString rigDevice;
    int     rigSpeed = 0;
    QString rigctldBin;
    int     intervalMs = 1000;
    bool    autoDetect = false;
    bool    autoDetectModel = false;
};

struct ProfileStore {
    QVector<Profile> profiles;
    QString          lastUsed;
};

struct ConnectRequest {
    bool    autoDetect = false;
    bool    autoDetectModel = false;
    QString server;
    QString token;
    QString rigName;
    int     rigModel = 0;
    QString rigDevice;
    int     rigSpeed = 0;
    QString rigctldBin;
    int     intervalMs = 1000;
};

struct RigctldParams {
    QString binary;
    int     model = 0;
    QString rigLabel;
    QString device;
    int     speed = 0;
    QString host;
    int     port = 0;
    QString args;
};

Q_DECLARE_METATYPE(RigPreset)
Q_DECLARE_METATYPE(Profile)
Q_DECLARE_METATYPE(RigctldParams)
Q_DECLARE_METATYPE(ConnectRequest)
