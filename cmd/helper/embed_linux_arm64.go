//go:build linux && arm64 && with_rigctld

package main

import "embed"

//go:embed rigctld-bins/linux-arm64
var rigctldFS embed.FS

const rigctldFSDir = "rigctld-bins/linux-arm64"
