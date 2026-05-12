//go:build linux && amd64 && with_rigctld

package main

import "embed"

//go:embed rigctld-bins/linux-amd64
var rigctldFS embed.FS

const rigctldFSDir = "rigctld-bins/linux-amd64"
