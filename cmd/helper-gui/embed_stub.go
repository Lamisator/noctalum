//go:build !(linux && amd64 && with_rigctld) && !(linux && arm64 && with_rigctld) && !(windows && amd64 && with_rigctld)

package main

import "embed"

var rigctldFS embed.FS

const rigctldFSDir = ""
