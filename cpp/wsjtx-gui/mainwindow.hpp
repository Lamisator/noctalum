#pragma once

#include "credentials.hpp"
#include "session.hpp"
#include "types.hpp"

#include <QMainWindow>

class QCheckBox;
class QComboBox;
class QLabel;
class QLineEdit;
class QListWidget;
class QPushButton;

// Everything the operator sees, in one window.  The UI flows through three
// stages driven by the Session state:
//   1. Credentials (server / user / pass / UDP / remember)  → Log in
//   2. Contest picker (populated after login)               → Start bridge
//   3. Live listener (running, QSO stream in the log)       → Stop / Log out
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    MainWindow();

private slots:
    void onLoginClicked();
    void onLogoutClicked();
    void onStartClicked();
    void onStopClicked();
    void onForgetCredentialsClicked();

    // Session callbacks
    void onLoggedIn();
    void onContestsFetched(QList<Contest> contests);
    void onContestSelected(qint64 id);
    void onListeningStarted(QString bindDesc);
    void onListeningStopped();
    void onQsoLogged(LogQSO qso);
    void onQsoFailed(LogQSO qso, QString msg);
    void onError(QString msg);

private:
    void buildUi();
    void applyStyle();

    void appendLog(const QString& msg, const QString& tone = QString());
    void setPhase(const QString& key, const QString& state, const QString& message = {});
    void resetPhases();

    // Stage transitions.  These wire enable/disable state across the whole
    // form so an operator can't fire an action that doesn't make sense for
    // the current session state.
    enum class Stage { LoggedOut, LoggedIn, Selecting, Listening };
    void setStage(Stage s);

    BridgeConfig formConfig() const;
    void loadFromCredentials(const Credentials& c);

    Session*  session_ = nullptr;
    Stage     stage_   = Stage::LoggedOut;

    // Credentials card
    QLineEdit*   inServer_   = nullptr;
    QLineEdit*   inUser_     = nullptr;
    QLineEdit*   inPass_     = nullptr;
    QLineEdit*   inUdp_      = nullptr;
    QCheckBox*   cbRemember_ = nullptr;
    QCheckBox*   cbForceDup_ = nullptr;
    QPushButton* btnLogin_   = nullptr;
    QPushButton* btnLogout_  = nullptr;
    QPushButton* btnForget_  = nullptr;

    // Contest card
    QComboBox*   contestCombo_ = nullptr;
    QPushButton* btnStart_     = nullptr;
    QPushButton* btnStop_      = nullptr;

    // Progress + log
    struct PhaseUi { QLabel* dot; QLabel* label; };
    QMap<QString, PhaseUi> phases_;
    QLabel*      phaseNote_ = nullptr;
    QListWidget* logView_   = nullptr;
    QLabel*      statusPill_ = nullptr;
    QLabel*      qsoCounter_ = nullptr;
    int          qsoCount_   = 0;
};
