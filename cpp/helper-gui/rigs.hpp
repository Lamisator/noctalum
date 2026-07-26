#pragma once

#include "types.hpp"
#include <QVector>

// Curated shortlist used for the "which rig do you have" dropdown and as the
// first attempts during auto-detect.  Order matters — probing runs the list
// in order, so common contest rigs come first.
QVector<RigPreset> curated_rigs();

// Enumerate every rig Hamlib knows about by invoking `rigctld -l` and parsing
// its output.  Falls back to `curated_rigs()` if the binary can't be run.
// Excludes "software" rigs (Vendor="Hamlib", labels containing "dummy",
// "demo", or "NET rigctl") so they don't clutter the auto-detect scan.
QVector<RigPreset> all_rigs(const QString& rigctld_bin);
