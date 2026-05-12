//go:build windows && amd64 && with_rigctld

package main

import "embed"

// Embeds rigctld.exe plus all DLLs it depends on.
//
//go:embed rigctld-bins/windows-amd64
var rigctldFS embed.FS

const rigctldFSDir = "rigctld-bins/windows-amd64"
