#pragma once

#include "types.hpp"

#include <QNetworkCookieJar>
#include <QNetworkAccessManager>
#include <QObject>
#include <QString>
#include <QUdpSocket>
#include <functional>

// Session drives the two multi-step network flows: login+contest-select
// (interactive, results reported back to the GUI) and the long-lived UDP
// listener that forwards WSJT-X LOG_QSO packets to /api/qsos.
//
// It runs on the GUI thread — every network operation is fully async with
// Qt's event loop, so nothing here blocks the UI.  That also makes it safe
// to touch widgets directly from the completion callbacks the MainWindow
// hooks up via the Qt signals below.
class Session : public QObject {
    Q_OBJECT
public:
    explicit Session(QObject* parent = nullptr);

    // Sends POST /api/login and, on success, remembers the CSRF token
    // internally and emits loggedIn().  On failure emits errorRaised().
    void login(const BridgeConfig& cfg);

    // GET /api/contests → contestsFetched() or errorRaised().  Requires a
    // previous successful login (cookie jar + CSRF token).
    void fetchContests();

    // POST /api/contests/{id}/select → contestSelected() or errorRaised().
    void selectContest(qint64 id);

    // Bind the UDP socket and start forwarding QSOs to the server.  Each
    // received LOG_QSO triggers a POST /api/qsos and emits qsoLogged() or
    // qsoFailed() depending on the response.
    void startListening(const QString& udpAddr, bool forceDup);

    // Close the UDP socket.  Does not tear down the HTTP session, so the
    // operator can pick another contest without re-entering credentials.
    void stopListening();

    // True while startListening() has an open socket.
    bool isListening() const;

    // Drop the CSRF token and forget any cookies — used by "Log out".
    void reset();

signals:
    void loggedIn();
    void contestsFetched(QList<Contest> contests);
    void contestSelected(qint64 id);
    void listeningStarted(QString bindDescription);
    void listeningStopped();
    void qsoLogged(LogQSO qso);
    // For duplicates and other soft errors from POST /api/qsos.  The QSO
    // details are included so the log line stays informative.
    void qsoFailed(LogQSO qso, QString message);
    void errorRaised(QString message);

private:
    // Small helper that funnels every request through one QNetworkAccessManager
    // and applies the CSRF header on mutating verbs.  Callback receives the
    // HTTP status code and the raw response body.
    void httpJson(const QString& method,
                  const QString& url,
                  const QByteArray& body,
                  std::function<void(int status, QByteArray body, QString transportError)> cb);

    void onDatagramReady();

    QNetworkAccessManager  nam_;
    QString                serverBase_;   // "https://host[:port]" without trailing slash
    QString                csrf_;         // set after login
    QUdpSocket             udp_;
    bool                   forceDup_ = false;
};
