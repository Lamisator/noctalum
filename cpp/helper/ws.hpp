#pragma once

#include <functional>
#include <stdexcept>
#include <string>

namespace nhelper {

// Thrown when a WebSocket transport error prevents the session from making
// forward progress.  Session code catches this to trigger the "reconnect in 5s"
// loop.
class WsError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Very small blocking WebSocket client.  Owns its own libwebsockets context,
// keeps a per-connection service thread inside service() calls.  Only supports
// text frames and only what the helper actually needs.
class WsClient {
public:
    WsClient();
    ~WsClient();
    WsClient(const WsClient&) = delete;
    WsClient& operator=(const WsClient&) = delete;

    // Connect to the given URL (ws:// or wss://).  Blocks until the
    // handshake completes or throws WsError on failure.
    void connect(const std::string& url);

    // Send a text frame.  Thread-safe with respect to service().
    void send_text(const std::string& payload);

    // Run one service tick with the given timeout in ms.  Any received text
    // frames are delivered to on_text.  Returns true while the connection is
    // still alive, false once closed.
    bool service(int timeout_ms);

    // Cleanly close the connection.  Safe to call multiple times.
    void close();

    // Set the callback invoked from service() whenever a text frame arrives.
    void on_text(std::function<void(const std::string&)> cb);

    // Impl is defined in ws.cpp; exposed here only because the C-style
    // libwebsockets callback needs to touch its fields.
    struct Impl;

private:
    Impl* impl_;
};

}  // namespace nhelper
