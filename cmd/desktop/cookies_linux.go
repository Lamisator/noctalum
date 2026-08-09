// Cookie persistence for the WebKitGTK webview Wails uses on Linux.
//
// Wails v2's Linux backend does NOT configure a persistent cookie
// storage — its WebKitCookieManager defaults to in-memory, which means
// every process gets a fresh (empty) cookie jar and the session is
// lost the moment the wrapper exits.  It also means a secondary window
// spawned by OpenPanelWindow starts unauthenticated even when the
// parent is logged in, because the child's brand-new in-memory jar
// doesn't see the parent's cookies.
//
// We fix both by pinning the default web context's cookie manager to a
// SQLite file under the user's config dir.  Wails creates its webview
// with webkit_web_view_new_with_user_content_manager, which uses the
// default WebKitWebContext — so configuring THAT context (before Wails
// touches it) makes the setting apply to Wails' webview.
//
// Concurrent access: SQLite handles the parent+child sharing this file
// via its own locking; WebKit re-reads the on-disk state at startup,
// so a child spawned after a login sees the freshly-persisted session
// cookie.

//go:build linux

package main

/*
#cgo pkg-config: webkit2gtk-4.1
#include <webkit2/webkit2.h>
*/
import "C"

import (
	"fmt"
	"os"
	"path/filepath"
	"unsafe"
)

// setupPersistentCookies pins the default WebKit web context to a
// SQLite cookie jar at <user-config>/noctalum-desktop/cookies.sqlite.
// Safe to call multiple times (WebKit treats a repeat call as
// re-configuration on the same context).  Returns the resolved path so
// callers can log it.
func setupPersistentCookies() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "noctalum-desktop")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "cookies.sqlite")

	ctx := C.webkit_web_context_get_default()
	if ctx == nil {
		return path, fmt.Errorf("webkit_web_context_get_default returned NULL")
	}
	cm := C.webkit_web_context_get_cookie_manager(ctx)
	if cm == nil {
		return path, fmt.Errorf("webkit_web_context_get_cookie_manager returned NULL")
	}
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	C.webkit_cookie_manager_set_persistent_storage(cm, cPath, C.WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE)
	return path, nil
}
