#include "ws.hpp"

#include <atomic>
#include <cstring>
#include <libwebsockets.h>
#include <mutex>
#include <queue>
#include <stdexcept>
#include <string>

namespace nhelper {

// libwebsockets glues the per-connection state to the wsi (opaque pointer)
// via lws_wsi_user() — we set that to our Impl* at connect time.
struct WsClient::Impl {
    lws_context*     ctx           = nullptr;
    lws*             wsi           = nullptr;
    lws_protocols    protocols[2]  = {};

    // Handshake bookkeeping.  connect_done flips true once ESTABLISHED or the
    // connection errors — connect() spins service() until then.
    std::atomic<bool> connect_done{false};
    std::atomic<bool> established {false};
    std::atomic<bool> closed      {false};
    std::string      connect_error;

    // Pending outbound text frames.  Guarded by mutex; the writeable-callback
    // drains this queue one frame per callback (matching lws expectations).
    std::mutex               tx_mu;
    std::queue<std::string>  tx;

    // Reassembly buffer for chunked inbound frames.
    std::string rx_frag;

    // Delivered from service() when a full text frame is received.
    std::function<void(const std::string&)> on_text;
};

// Bridge from libwebsockets' C callback to our C++ Impl.
static int lws_cb(lws* wsi, lws_callback_reasons reason,
                  void* user, void* in, size_t len) {
    (void)user;
    auto* impl = static_cast<WsClient::Impl*>(lws_wsi_user(wsi));
    switch (reason) {
    case LWS_CALLBACK_CLIENT_ESTABLISHED:
        if (impl) { impl->established = true; impl->connect_done = true; }
        break;

    case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
        if (impl) {
            impl->connect_error = in ? std::string(static_cast<const char*>(in), len)
                                     : "connection error";
            impl->connect_done = true;
            impl->closed = true;
        }
        return -1;

    case LWS_CALLBACK_CLIENT_CLOSED:
        if (impl) impl->closed = true;
        break;

    case LWS_CALLBACK_CLIENT_RECEIVE:
        if (impl && in && len) {
            impl->rx_frag.append(static_cast<const char*>(in), len);
            if (lws_is_final_fragment(wsi)) {
                if (impl->on_text) impl->on_text(impl->rx_frag);
                impl->rx_frag.clear();
            }
        }
        break;

    case LWS_CALLBACK_CLIENT_WRITEABLE: {
        if (!impl) break;
        std::string frame;
        {
            std::lock_guard<std::mutex> g(impl->tx_mu);
            if (impl->tx.empty()) break;
            frame = std::move(impl->tx.front());
            impl->tx.pop();
        }
        // libwebsockets requires LWS_PRE bytes of pre-padding before the payload.
        std::vector<unsigned char> buf(LWS_PRE + frame.size());
        std::memcpy(buf.data() + LWS_PRE, frame.data(), frame.size());
        int n = lws_write(wsi, buf.data() + LWS_PRE, frame.size(), LWS_WRITE_TEXT);
        if (n < static_cast<int>(frame.size())) return -1;
        // If more frames are queued, ask for another writeable callback.
        {
            std::lock_guard<std::mutex> g(impl->tx_mu);
            if (!impl->tx.empty()) lws_callback_on_writable(wsi);
        }
        break;
    }

    default: break;
    }
    return 0;
}

WsClient::WsClient() : impl_(new Impl{}) {
    impl_->protocols[0] = {"noctalum-helper", lws_cb, 0, 65536, 0, nullptr, 0};
    impl_->protocols[1] = {};

    lws_context_creation_info info{};
    info.port        = CONTEXT_PORT_NO_LISTEN;
    info.protocols   = impl_->protocols;
    info.gid         = -1;
    info.uid         = -1;
    info.options     = LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;

    // Quiet libwebsockets — we log through our own log_line().
    lws_set_log_level(0, nullptr);

    impl_->ctx = lws_create_context(&info);
    if (!impl_->ctx) throw std::runtime_error("lws_create_context failed");
}

WsClient::~WsClient() {
    close();
    if (impl_->ctx) lws_context_destroy(impl_->ctx);
    delete impl_;
}

// Parse ws://host:port/path?query into components libwebsockets needs.
static void parse_ws_url(const std::string& url, bool& use_ssl, std::string& host,
                        int& port, std::string& path) {
    std::string u = url;
    if (u.rfind("wss://", 0) == 0) { use_ssl = true;  u.erase(0, 6); }
    else if (u.rfind("ws://", 0) == 0) { use_ssl = false; u.erase(0, 5); }
    else throw std::invalid_argument("URL must start with ws:// or wss://");

    auto slash = u.find('/');
    std::string hp = (slash == std::string::npos) ? u : u.substr(0, slash);
    path         = (slash == std::string::npos) ? "/" : u.substr(slash);

    auto colon = hp.find(':');
    if (colon == std::string::npos) {
        host = hp;
        port = use_ssl ? 443 : 80;
    } else {
        host = hp.substr(0, colon);
        port = std::stoi(hp.substr(colon + 1));
    }
}

void WsClient::connect(const std::string& url) {
    bool ssl = false;
    std::string host, path;
    int port = 0;
    parse_ws_url(url, ssl, host, port, path);

    lws_client_connect_info ci{};
    ci.context      = impl_->ctx;
    ci.address      = host.c_str();
    ci.port         = port;
    ci.path         = path.c_str();
    ci.host         = host.c_str();
    ci.origin       = host.c_str();
    ci.protocol     = impl_->protocols[0].name;
    ci.ssl_connection = ssl ? LCCSCF_USE_SSL : 0;
    ci.userdata     = impl_;   // becomes lws_wsi_user()

    impl_->wsi = lws_client_connect_via_info(&ci);
    if (!impl_->wsi) throw WsError("lws_client_connect_via_info returned null");

    // Spin the service loop until the handshake finishes (or fails).
    // 10 s should cover a slow TLS handshake without hanging forever.
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!impl_->connect_done && std::chrono::steady_clock::now() < deadline) {
        lws_service(impl_->ctx, 100);
    }
    if (!impl_->established) {
        std::string msg = impl_->connect_error.empty()
            ? std::string("connection failed")
            : impl_->connect_error;
        throw WsError("ws dial to " + url + ": " + msg);
    }
}

void WsClient::send_text(const std::string& payload) {
    {
        std::lock_guard<std::mutex> g(impl_->tx_mu);
        impl_->tx.push(payload);
    }
    if (impl_->wsi) {
        // Wake the service loop so it schedules a writeable callback.
        lws_callback_on_writable(impl_->wsi);
        lws_cancel_service(impl_->ctx);
    }
}

bool WsClient::service(int timeout_ms) {
    if (impl_->closed) return false;
    lws_service(impl_->ctx, timeout_ms);
    return !impl_->closed;
}

void WsClient::on_text(std::function<void(const std::string&)> cb) {
    impl_->on_text = std::move(cb);
}

void WsClient::close() {
    if (impl_->wsi) {
        lws_set_timeout(impl_->wsi, PENDING_TIMEOUT_CLOSE_SEND,
                        LWS_TO_KILL_ASYNC);
        // One more service pass so libwebsockets sends the close frame.
        if (impl_->ctx) lws_service(impl_->ctx, 100);
        impl_->wsi = nullptr;
    }
    impl_->closed = true;
}

}  // namespace nhelper
