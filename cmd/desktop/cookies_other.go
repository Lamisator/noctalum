// Stub for the non-Linux builds — macOS' WKWebView and Windows'
// WebView2 use persistent cookie storage out of the box (WKWebView via
// the default WKWebsiteDataStore; WebView2 via %AppData%/<exe>), so
// there's nothing for us to configure there.

//go:build !linux

package main

func setupPersistentCookies() (string, error) { return "", nil }
