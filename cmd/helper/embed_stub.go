//go:build !(linux && amd64 && with_rigctld) && !(linux && arm64 && with_rigctld) && !(windows && amd64 && with_rigctld)

package main

import "embed"

// No rigctld is bundled for this platform/configuration.
// defaultRigctldBin() falls back to PATH and well-known install locations.
var rigctldFS embed.FS

const rigctldFSDir = ""
