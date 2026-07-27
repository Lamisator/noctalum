#include "mainwindow.hpp"

#include <QApplication>
#include <QButtonGroup>
#include <QCheckBox>
#include <QComboBox>
#include <QDateTime>
#include <QFontDatabase>
#include <QFormLayout>
#include <QFrame>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QMessageBox>
#include <QPushButton>
#include <QRadioButton>
#include <QScrollBar>
#include <QStackedWidget>
#include <QVBoxLayout>

namespace {

// Central palette — mirrors internal/server/web/style.css so the desktop
// bridge visually belongs to the same product family as the web UI.
struct Palette {
    static constexpr const char* kBg          = "#121417";
    static constexpr const char* kBgElev      = "#1c1f24";
    static constexpr const char* kBgElev2     = "#242830";
    static constexpr const char* kBorder      = "#2c3138";
    static constexpr const char* kText        = "#e6eaf0";
    static constexpr const char* kTextMuted   = "#8a93a1";
    static constexpr const char* kAccent      = "#4fc3f7";
    static constexpr const char* kAccentStrong= "#29b6f6";
    static constexpr const char* kSuccess     = "#66bb6a";
    static constexpr const char* kError       = "#ef5350";
    static constexpr const char* kWarn        = "#ffb74d";
};

// Frameless card container styled like the web UI's ".card".  Reused for
// each section so the layout stays visually consistent.
QGroupBox* makeCard(const QString& title) {
    auto* c = new QGroupBox(title);
    c->setObjectName("card");
    return c;
}

QLabel* muted(const QString& text) {
    auto* l = new QLabel(text);
    l->setObjectName("muted");
    return l;
}

}  // namespace

MainWindow::MainWindow() {
    setWindowTitle(tr("Noctalum · WSJT-X Bridge"));
    resize(720, 720);
    setMinimumSize(560, 620);

    session_ = new Session(this);
    connect(session_, &Session::loggedIn,          this, &MainWindow::onLoggedIn);
    connect(session_, &Session::contestsFetched,   this, &MainWindow::onContestsFetched);
    connect(session_, &Session::contestSelected,   this, &MainWindow::onContestSelected);
    connect(session_, &Session::listeningStarted,  this, &MainWindow::onListeningStarted);
    connect(session_, &Session::listeningStopped,  this, &MainWindow::onListeningStopped);
    connect(session_, &Session::qsoLogged,         this, &MainWindow::onQsoLogged);
    connect(session_, &Session::qsoFailed,         this, &MainWindow::onQsoFailed);
    connect(session_, &Session::errorRaised,       this, &MainWindow::onError);

    buildUi();
    applyStyle();
    setStage(Stage::LoggedOut);
    loadFromCredentials(CredentialStore::load());
    appendLog(tr("Ready. Paste a bridge token or switch to username/password to begin."));
}

// ── UI construction ─────────────────────────────────────────────────────

void MainWindow::buildUi() {
    auto* central = new QWidget();
    auto* root = new QVBoxLayout(central);
    root->setContentsMargins(20, 20, 20, 20);
    root->setSpacing(14);
    setCentralWidget(central);

    // ── Header (brand + status pill) ──
    {
        auto* bar = new QHBoxLayout();
        auto* brand = new QLabel();
        brand->setTextFormat(Qt::RichText);
        brand->setText(QStringLiteral(
            "<span style='color:%1;font-weight:600;font-size:16px;'>Noctalum</span>"
            "<span style='color:%2;'>&nbsp;·&nbsp;WSJT-X Bridge</span>")
            .arg(Palette::kAccent, Palette::kTextMuted));

        statusPill_ = new QLabel(tr("Offline"));
        statusPill_->setObjectName("pill-offline");
        statusPill_->setAlignment(Qt::AlignCenter);
        statusPill_->setMinimumWidth(88);

        bar->addWidget(brand);
        bar->addStretch();
        bar->addWidget(statusPill_);
        root->addLayout(bar);
    }

    // ── Credentials card (auth-mode toggle + swapped body) ──
    {
        auto* card = makeCard(tr("Connection"));

        // Mode toggle — token mode is the default because it's the
        // one-click config path the web UI is designed to produce.
        // Classic username/password is kept as an escape hatch.
        rbToken_    = new QRadioButton(tr("Bridge token (one click)"));
        rbPassword_ = new QRadioButton(tr("Username &amp; password"));
        rbToken_->setChecked(true);
        auto* modeGroup = new QButtonGroup(this);
        modeGroup->addButton(rbToken_);
        modeGroup->addButton(rbPassword_);
        auto* modeRow = new QHBoxLayout();
        modeRow->addWidget(rbToken_);
        modeRow->addWidget(rbPassword_);
        modeRow->addStretch();

        // Shared fields (UDP + duplicate toggle) appear beneath the
        // per-mode body so they belong to both flows.
        inUdp_ = new QLineEdit(QStringLiteral("0.0.0.0:2237"));
        inUdp_->setPlaceholderText(QStringLiteral("0.0.0.0:2237"));
        cbForceDup_ = new QCheckBox(tr("Log duplicates (send QSOs even when the server flags them)"));

        // ── Token-mode sub-card ──
        auto* tokenPage = new QWidget();
        {
            inToken_ = new QLineEdit();
            inToken_->setPlaceholderText(QStringLiteral("noc1.…"));
            inToken_->setEchoMode(QLineEdit::Password);
            cbRememberToken_ = new QCheckBox(tr("Remember token on this device"));
            cbRememberToken_->setToolTip(tr(
                "The token is saved to a per-user JSON file with owner-only "
                "permissions. Leave unchecked on shared machines."));

            btnTokenStart_ = new QPushButton(tr("Start bridge"));
            btnTokenStart_->setObjectName("primary");
            btnTokenStart_->setDefault(true);
            btnTokenStop_  = new QPushButton(tr("Stop"));

            auto* form = new QFormLayout();
            form->setLabelAlignment(Qt::AlignRight);
            form->setContentsMargins(4, 6, 4, 6);
            form->setSpacing(10);
            form->addRow(tr("Bridge token"), inToken_);
            form->addRow(tr("WSJT-X UDP"),   inUdp_);
            form->addRow(QString(),          cbRememberToken_);
            form->addRow(QString(),          cbForceDup_);

            auto* actions = new QHBoxLayout();
            actions->addStretch();
            actions->addWidget(btnTokenStop_);
            actions->addWidget(btnTokenStart_);

            auto* body = new QVBoxLayout(tokenPage);
            body->setContentsMargins(0, 0, 0, 0);
            body->addWidget(muted(tr(
                "Paste the token you copied from Noctalum → My Settings → "
                "\"WSJT-X bridge token\". It contains the server URL, your "
                "helper token, and the contest to log into.")));
            body->addLayout(form);
            body->addLayout(actions);

            connect(btnTokenStart_, &QPushButton::clicked, this, &MainWindow::onTokenStartClicked);
            connect(btnTokenStop_,  &QPushButton::clicked, this, &MainWindow::onStopClicked);
            connect(inToken_,       &QLineEdit::returnPressed, btnTokenStart_, &QPushButton::click);
        }

        // ── Password-mode sub-card ──
        auto* pwdPage = new QWidget();
        {
            inServer_ = new QLineEdit();
            inServer_->setPlaceholderText(QStringLiteral("https://log.example.org"));
            inUser_ = new QLineEdit();
            inUser_->setPlaceholderText(tr("callsign or username"));
            inPass_ = new QLineEdit();
            inPass_->setEchoMode(QLineEdit::Password);

            cbRemember_ = new QCheckBox(tr("Remember credentials on this device"));
            cbRemember_->setToolTip(tr(
                "Credentials are saved to a per-user JSON file with owner-only "
                "permissions. Leave unchecked on shared machines."));

            btnLogin_  = new QPushButton(tr("Log in"));
            btnLogin_->setObjectName("primary");
            btnLogout_ = new QPushButton(tr("Log out"));

            auto* form = new QFormLayout();
            form->setLabelAlignment(Qt::AlignRight);
            form->setContentsMargins(4, 6, 4, 6);
            form->setSpacing(10);
            form->addRow(tr("Server URL"), inServer_);
            form->addRow(tr("Username"),   inUser_);
            form->addRow(tr("Password"),   inPass_);
            form->addRow(QString(),        cbRemember_);

            auto* actions = new QHBoxLayout();
            actions->addStretch();
            actions->addWidget(btnLogout_);
            actions->addWidget(btnLogin_);

            auto* body = new QVBoxLayout(pwdPage);
            body->setContentsMargins(0, 0, 0, 0);
            body->addLayout(form);
            body->addLayout(actions);

            connect(btnLogin_,  &QPushButton::clicked, this, &MainWindow::onLoginClicked);
            connect(btnLogout_, &QPushButton::clicked, this, &MainWindow::onLogoutClicked);
            connect(inPass_,    &QLineEdit::returnPressed, btnLogin_, &QPushButton::click);
        }

        authStack_ = new QStackedWidget();
        authStack_->addWidget(tokenPage);   // index 0 → Token
        authStack_->addWidget(pwdPage);     // index 1 → Password

        btnForget_ = new QPushButton(tr("Forget saved credentials"));
        btnForget_->setObjectName("ghost");
        auto* footerRow = new QHBoxLayout();
        footerRow->addWidget(btnForget_);
        footerRow->addStretch();

        auto* body = new QVBoxLayout();
        body->addLayout(modeRow);
        body->addWidget(authStack_);
        body->addLayout(footerRow);
        card->setLayout(body);
        root->addWidget(card);

        connect(rbToken_,    &QRadioButton::toggled, this, &MainWindow::onAuthModeChanged);
        connect(rbPassword_, &QRadioButton::toggled, this, &MainWindow::onAuthModeChanged);
        connect(btnForget_,  &QPushButton::clicked,  this, &MainWindow::onForgetCredentialsClicked);
    }

    // ── Contest card (password mode only) ──
    {
        auto* card = makeCard(tr("Contest"));
        contestCard_  = card;
        contestCombo_ = new QComboBox();
        contestCombo_->setMinimumHeight(30);
        btnStart_ = new QPushButton(tr("Start bridge"));
        btnStart_->setObjectName("primary");
        btnStop_  = new QPushButton(tr("Stop"));

        auto* row = new QHBoxLayout();
        row->addWidget(contestCombo_, 1);
        row->addWidget(btnStart_);
        row->addWidget(btnStop_);

        auto* body = new QVBoxLayout();
        body->addWidget(muted(tr(
            "Pick the contest that receives every QSO WSJT-X reports on the "
            "UDP port above.")));
        body->addLayout(row);
        card->setLayout(body);
        root->addWidget(card);

        connect(btnStart_, &QPushButton::clicked, this, &MainWindow::onStartClicked);
        connect(btnStop_,  &QPushButton::clicked, this, &MainWindow::onStopClicked);
    }

    // ── Progress dots ──
    {
        auto* card = makeCard(tr("Status"));
        auto* row = new QHBoxLayout();
        row->setSpacing(6);
        for (const auto& [key, label] : std::vector<std::pair<QString, QString>>{
                 {"login",   tr("Signed in")},
                 {"contest", tr("Contest ready")},
                 {"listen",  tr("Listening")},
                 {"qso",     tr("QSOs flowing")}}) {
            auto* dot = new QLabel(QStringLiteral("●"));
            dot->setStyleSheet(QString("color: %1; font-size: 18px;").arg(Palette::kBgElev2));
            dot->setAlignment(Qt::AlignCenter);
            auto* txt = new QLabel(label);
            txt->setAlignment(Qt::AlignCenter);
            txt->setStyleSheet(QString("color: %1; font-size: 12px;").arg(Palette::kTextMuted));

            auto* col = new QVBoxLayout();
            col->setSpacing(2);
            col->addWidget(dot,  0, Qt::AlignHCenter);
            col->addWidget(txt,  0, Qt::AlignHCenter);
            row->addLayout(col, 1);
            phases_[key] = {dot, txt};
        }
        phaseNote_ = new QLabel(tr("Not connected."));
        phaseNote_->setAlignment(Qt::AlignCenter);
        phaseNote_->setObjectName("muted");

        auto* body = new QVBoxLayout();
        body->addLayout(row);
        body->addSpacing(6);
        body->addWidget(phaseNote_);
        card->setLayout(body);
        root->addWidget(card);
    }

    // ── Activity log ──
    {
        auto* card = makeCard(tr("Activity"));
        logView_ = new QListWidget();
        logView_->setObjectName("log");
        logView_->setSelectionMode(QAbstractItemView::NoSelection);
        logView_->setFocusPolicy(Qt::NoFocus);
        logView_->setFont(QFontDatabase::systemFont(QFontDatabase::FixedFont));

        qsoCounter_ = new QLabel(tr("0 QSOs logged"));
        qsoCounter_->setStyleSheet(QString("color: %1;").arg(Palette::kTextMuted));
        auto* clear = new QPushButton(tr("Clear"));
        clear->setObjectName("ghost");
        auto* head = new QHBoxLayout();
        head->addWidget(qsoCounter_);
        head->addStretch();
        head->addWidget(clear);

        auto* body = new QVBoxLayout();
        body->addLayout(head);
        body->addWidget(logView_, 1);
        card->setLayout(body);
        root->addWidget(card, 1);

        connect(clear, &QPushButton::clicked, logView_, &QListWidget::clear);
    }
}

// Applies the dark theme.  We keep the palette here (not in an external .qss
// file) so the AppImage / .app / .exe is genuinely one file with no
// runtime resource lookups.
void MainWindow::applyStyle() {
    QString qss = QString(R"(
        QMainWindow, QWidget#centralwidget { background-color: %BG%; }
        QWidget { color: %TEXT%; }
        QLabel { background: transparent; }
        QLabel#muted { color: %MUTED%; }

        QGroupBox#card {
            background-color: %BG_ELEV%;
            border: 1px solid %BORDER%;
            border-radius: 10px;
            margin-top: 14px;
            padding: 14px 14px 12px 14px;
            font-weight: 600;
        }
        QGroupBox#card::title {
            subcontrol-origin: margin;
            subcontrol-position: top left;
            left: 12px;
            padding: 0 6px;
            color: %ACCENT%;
            background-color: %BG_ELEV%;
        }

        QLineEdit, QComboBox {
            background-color: %BG_ELEV2%;
            border: 1px solid %BORDER%;
            border-radius: 6px;
            padding: 6px 8px;
            selection-background-color: %ACCENT_DIM%;
            selection-color: %TEXT%;
        }
        QLineEdit:focus, QComboBox:focus {
            border: 1px solid %ACCENT%;
        }
        QComboBox::drop-down { border: none; width: 22px; }
        QComboBox QAbstractItemView {
            background-color: %BG_ELEV2%;
            color: %TEXT%;
            border: 1px solid %BORDER%;
            selection-background-color: %ACCENT_DIM%;
        }

        QCheckBox { spacing: 8px; color: %TEXT%; }
        QCheckBox::indicator {
            width: 15px; height: 15px;
            border-radius: 3px;
            border: 1px solid %BORDER%;
            background: %BG_ELEV2%;
        }
        QCheckBox::indicator:checked {
            background: %ACCENT%;
            border: 1px solid %ACCENT%;
            image: none;
        }

        QPushButton {
            background-color: %BG_ELEV2%;
            color: %TEXT%;
            border: 1px solid %BORDER%;
            border-radius: 6px;
            padding: 6px 14px;
            min-height: 20px;
        }
        QPushButton:hover { border-color: %ACCENT%; }
        QPushButton:disabled { color: %MUTED%; border-color: %BORDER%; }

        QPushButton#primary {
            background-color: %ACCENT%;
            color: #0b1116;
            border: 1px solid %ACCENT%;
            font-weight: 600;
        }
        QPushButton#primary:hover { background-color: %ACCENT_STRONG%; border-color: %ACCENT_STRONG%; }
        QPushButton#primary:disabled { background-color: %BG_ELEV2%; color: %MUTED%; border-color: %BORDER%; }

        QPushButton#ghost {
            background: transparent;
            border: 1px solid transparent;
            color: %MUTED%;
        }
        QPushButton#ghost:hover { color: %TEXT%; border-color: %BORDER%; }

        QListWidget#log {
            background-color: %BG%;
            border: 1px solid %BORDER%;
            border-radius: 6px;
            padding: 6px;
            font-size: 12px;
        }
        QListWidget#log::item { padding: 2px 4px; border: none; }

        QLabel#pill-offline, QLabel#pill-online, QLabel#pill-listening {
            padding: 3px 10px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: 600;
        }
        QLabel#pill-offline   { background-color: %BG_ELEV2%; color: %MUTED%; }
        QLabel#pill-online    { background-color: rgba(79,195,247,0.18); color: %ACCENT%; }
        QLabel#pill-listening { background-color: rgba(102,187,106,0.20); color: %SUCCESS%; }

        QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
        QScrollBar::handle:vertical {
            background: %BG_ELEV2%; border-radius: 4px; min-height: 24px;
        }
        QScrollBar::handle:vertical:hover { background: %BORDER%; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
    )")
      .replace("%BG%",           Palette::kBg)
      .replace("%BG_ELEV2%",     Palette::kBgElev2)
      .replace("%BG_ELEV%",      Palette::kBgElev)
      .replace("%BORDER%",       Palette::kBorder)
      .replace("%TEXT%",         Palette::kText)
      .replace("%MUTED%",        Palette::kTextMuted)
      .replace("%ACCENT_STRONG%",Palette::kAccentStrong)
      .replace("%ACCENT_DIM%",   "rgba(79,195,247,0.18)")
      .replace("%ACCENT%",       Palette::kAccent)
      .replace("%SUCCESS%",      Palette::kSuccess);

    qApp->setStyleSheet(qss);
    if (centralWidget()) centralWidget()->setObjectName("centralwidget");
}

// ── Stage machine ───────────────────────────────────────────────────────

void MainWindow::setStage(Stage s) {
    stage_ = s;
    const bool loggedOut = (s == Stage::LoggedOut);
    const bool listening = (s == Stage::Listening || s == Stage::TokenStreaming);
    const bool tokenMode = (authMode() == AuthMode::Token);

    // Password-mode inputs stay locked while a session is active; token
    // mode has no login step so the fields only lock during listening.
    inServer_->setEnabled(loggedOut);
    inUser_->setEnabled(loggedOut);
    inPass_->setEnabled(loggedOut);
    cbRemember_->setEnabled(loggedOut);
    btnLogin_->setEnabled(loggedOut && !tokenMode);
    btnLogout_->setEnabled(!loggedOut && !listening && !tokenMode);

    inToken_->setEnabled(!listening);
    cbRememberToken_->setEnabled(!listening);
    btnTokenStart_->setEnabled(!listening && tokenMode);
    btnTokenStop_->setEnabled(s == Stage::TokenStreaming);

    contestCombo_->setEnabled(!loggedOut && !listening && !tokenMode);
    btnStart_->setEnabled(s == Stage::LoggedIn && contestCombo_->count() > 0);
    btnStop_->setEnabled(s == Stage::Listening);
    inUdp_->setEnabled(!listening);
    cbForceDup_->setEnabled(!listening);
    rbToken_->setEnabled(loggedOut && !listening);
    rbPassword_->setEnabled(loggedOut && !listening);
    if (contestCard_) contestCard_->setVisible(!tokenMode);

    if (listening) {
        statusPill_->setText(tr("Listening"));
        statusPill_->setObjectName("pill-listening");
    } else if (!loggedOut) {
        statusPill_->setText(tr("Signed in"));
        statusPill_->setObjectName("pill-online");
    } else {
        statusPill_->setText(tr("Offline"));
        statusPill_->setObjectName("pill-offline");
    }
    // QSS pseudo-selectors need a re-polish after objectName changes.
    statusPill_->style()->unpolish(statusPill_);
    statusPill_->style()->polish(statusPill_);
}

MainWindow::AuthMode MainWindow::authMode() const {
    return rbToken_ && rbToken_->isChecked() ? AuthMode::Token : AuthMode::Password;
}

void MainWindow::setAuthMode(AuthMode m) {
    // Guard against re-entering the toggled() signal that fires while we
    // flip the pair below.
    QSignalBlocker b1(rbToken_), b2(rbPassword_);
    rbToken_->setChecked(m == AuthMode::Token);
    rbPassword_->setChecked(m == AuthMode::Password);
    if (authStack_) authStack_->setCurrentIndex(m == AuthMode::Token ? 0 : 1);
    setStage(stage_);  // re-apply enable/disable rules for the new mode
}

void MainWindow::onAuthModeChanged() {
    if (!rbToken_ || !rbPassword_) return;
    auto m = rbToken_->isChecked() ? AuthMode::Token : AuthMode::Password;
    if (authStack_) authStack_->setCurrentIndex(m == AuthMode::Token ? 0 : 1);
    // Fresh-state reset when the operator switches modes mid-session: no
    // point keeping the old mode's phase indicators or a stale contest
    // list around.
    if (stage_ != Stage::Listening && stage_ != Stage::TokenStreaming) {
        session_->reset();
        contestCombo_->clear();
        resetPhases();
        setStage(Stage::LoggedOut);
    }
}

// ── Actions ─────────────────────────────────────────────────────────────

BridgeConfig MainWindow::formConfig() const {
    BridgeConfig c;
    c.server   = inServer_->text().trimmed();
    c.user     = inUser_->text().trimmed();
    c.pass     = inPass_->text();
    c.udp      = inUdp_->text().trimmed().isEmpty() ? QStringLiteral("0.0.0.0:2237")
                                                    : inUdp_->text().trimmed();
    c.forceDup = cbForceDup_->isChecked();
    return c;
}

void MainWindow::loadFromCredentials(const Credentials& c) {
    if (!c.server.isEmpty()) inServer_->setText(c.server);
    if (!c.user.isEmpty())   inUser_->setText(c.user);
    if (!c.udp.isEmpty())    inUdp_->setText(c.udp);
    if (c.rememberPass)      inPass_->setText(c.pass);
    if (c.rememberToken)     inToken_->setText(c.token);
    cbRemember_->setChecked(c.rememberPass);
    cbRememberToken_->setChecked(c.rememberToken);
    cbForceDup_->setChecked(c.forceDup);

    // Restore the last-used auth mode. New installs default to token
    // (the mode built for one-click config); a legacy config that predates
    // this field lands on password only if it carried a remembered
    // password, otherwise the token default wins.
    AuthMode m = AuthMode::Token;
    if (c.authMode == QStringLiteral("password"))      m = AuthMode::Password;
    else if (c.authMode == QStringLiteral("token"))    m = AuthMode::Token;
    else if (c.rememberPass && !c.pass.isEmpty())      m = AuthMode::Password;
    setAuthMode(m);

    if (m == AuthMode::Token && c.rememberToken && !c.token.isEmpty()) {
        appendLog(tr("Loaded saved token — press Start bridge to connect."));
    } else if (m == AuthMode::Password && c.rememberPass && !c.pass.isEmpty()) {
        appendLog(tr("Loaded saved credentials — press Log in to continue."));
    }
}

void MainWindow::onLoginClicked() {
    BridgeConfig cfg = formConfig();
    if (cfg.server.isEmpty()) { QMessageBox::warning(this, tr("Log in"), tr("Server URL is required.")); return; }
    if (cfg.user.isEmpty())   { QMessageBox::warning(this, tr("Log in"), tr("Username is required.")); return; }
    if (cfg.pass.isEmpty())   { QMessageBox::warning(this, tr("Log in"), tr("Password is required.")); return; }

    btnLogin_->setEnabled(false);
    appendLog(tr("Signing in to %1…").arg(cfg.server));
    session_->login(cfg);
}

void MainWindow::onLogoutClicked() {
    session_->reset();
    contestCombo_->clear();
    resetPhases();
    setPhase("login", "idle");
    setStage(Stage::LoggedOut);
    appendLog(tr("Signed out."));
}

void MainWindow::onTokenStartClicked() {
    QString blob = inToken_->text().trimmed();
    if (blob.isEmpty()) {
        QMessageBox::warning(this, tr("Start bridge"),
            tr("Paste the bridge token from Noctalum → My Settings first."));
        return;
    }
    if (!session_->configureToken(blob)) {
        // configureToken already emitted errorRaised() → onError() logged.
        return;
    }
    // The two phases the password flow uses don't apply here — the token
    // combines both.  Mark them as "skipped" so the progress row shows
    // the user what happened.
    setPhase("login",   "done", tr("token accepted"));
    setPhase("contest", "done", tr("contest embedded in token"));
    appendLog(tr("Bridge token accepted — starting UDP listener…"), "ok");

    // Persist the token/UDP/dup config only after we know the token
    // parses.  A malformed paste is not saved.
    Credentials c;
    c.server        = inServer_->text().trimmed();
    c.user          = inUser_->text().trimmed();
    c.pass          = inPass_->text();
    c.rememberPass  = cbRemember_->isChecked();
    c.udp           = inUdp_->text().trimmed();
    c.forceDup      = cbForceDup_->isChecked();
    c.authMode      = QStringLiteral("token");
    c.token         = blob;
    c.rememberToken = cbRememberToken_->isChecked();
    CredentialStore::save(c);

    setStage(Stage::TokenStreaming);
    session_->startListening(inUdp_->text().trimmed(), cbForceDup_->isChecked());
}

void MainWindow::onStartClicked() {
    if (contestCombo_->count() == 0) return;
    qint64 id = contestCombo_->currentData().toLongLong();
    setStage(Stage::Selecting);
    appendLog(tr("Selecting contest \"%1\"…").arg(contestCombo_->currentText()));
    session_->selectContest(id);
}

void MainWindow::onStopClicked() {
    session_->stopListening();
}

void MainWindow::onForgetCredentialsClicked() {
    auto r = QMessageBox::question(this, tr("Forget credentials"),
        tr("Delete saved credentials from this device?\n\nPath: %1")
            .arg(CredentialStore::path()));
    if (r != QMessageBox::Yes) return;
    CredentialStore::clear();
    inPass_->clear();
    inToken_->clear();
    cbRemember_->setChecked(false);
    cbRememberToken_->setChecked(false);
    appendLog(tr("Saved credentials removed."));
}

// ── Session callbacks ───────────────────────────────────────────────────

void MainWindow::onLoggedIn() {
    setPhase("login", "done", tr("signed in as %1").arg(inUser_->text().trimmed()));
    appendLog(tr("Signed in. Fetching contests…"), "ok");

    // Persist credentials AFTER a successful login so we never save
    // credentials the server would reject.
    Credentials c;
    c.server        = inServer_->text().trimmed();
    c.user          = inUser_->text().trimmed();
    c.pass          = inPass_->text();
    c.udp           = inUdp_->text().trimmed();
    c.rememberPass  = cbRemember_->isChecked();
    c.forceDup      = cbForceDup_->isChecked();
    c.authMode      = QStringLiteral("password");
    c.token         = inToken_->text().trimmed();
    c.rememberToken = cbRememberToken_->isChecked();
    CredentialStore::save(c);

    setStage(Stage::LoggedIn);
    session_->fetchContests();
}

void MainWindow::onContestsFetched(QList<Contest> contests) {
    contestCombo_->clear();
    if (contests.isEmpty()) {
        contestCombo_->addItem(tr("(no contests — create one in the web UI)"), QVariant());
        contestCombo_->setEnabled(false);
        setPhase("contest", "error", tr("no contests on server"));
        appendLog(tr("Server returned no contests. Create one in the web UI first."), "warn");
        return;
    }
    for (const auto& c : contests) {
        QString label = QString("%1  ·  %2  ·  %3").arg(c.name, c.stationCall, c.status);
        contestCombo_->addItem(label, QVariant::fromValue<qint64>(c.id));
    }
    contestCombo_->setEnabled(true);
    btnStart_->setEnabled(true);
    setPhase("contest", "active", tr("pick a contest and press Start"));
    appendLog(tr("Loaded %n contest(s).", "", static_cast<int>(contests.size())));
}

void MainWindow::onContestSelected(qint64 /*id*/) {
    setPhase("contest", "done", tr("selected \"%1\"").arg(contestCombo_->currentText()));
    appendLog(tr("Contest ready — starting UDP listener…"), "ok");
    session_->startListening(inUdp_->text().trimmed(), cbForceDup_->isChecked());
}

void MainWindow::onListeningStarted(QString bindDesc) {
    setPhase("listen", "done", tr("bound to %1").arg(bindDesc));
    setPhase("qso",    "active", tr("waiting for the first QSO"));
    setStage(Stage::Listening);
    appendLog(tr("Listening on %1 for WSJT-X.").arg(bindDesc), "ok");
}

void MainWindow::onListeningStopped() {
    setPhase("listen", "idle");
    setPhase("qso",    "idle");
    // Token mode has no in-between "signed in" stage — Stop returns the
    // operator to the pasted-token idle state, not to a contest picker.
    if (authMode() == AuthMode::Token) {
        session_->reset();
        setStage(Stage::LoggedOut);
    } else {
        setStage(Stage::LoggedIn);
    }
    appendLog(tr("Stopped listening."));
}

void MainWindow::onQsoLogged(LogQSO qso) {
    ++qsoCount_;
    qsoCounter_->setText(tr("%n QSO(s) logged", "", qsoCount_));
    setPhase("qso", "done", tr("%n QSO(s) sent to server", "", qsoCount_));

    QString line = QString("%1  %2  %3  sent %4  rcvd %5")
        .arg(qso.call, -12)
        .arg(qso.mode, -6)
        .arg(QString::number(qso.freqHz / 1000.0, 'f', 1) + " kHz")
        .arg(qso.rstSent, -4)
        .arg(qso.rstReceived);
    appendLog(line, "ok");
}

void MainWindow::onQsoFailed(LogQSO qso, QString msg) {
    appendLog(tr("QSO %1: %2").arg(qso.call, msg), "warn");
}

void MainWindow::onError(QString msg) {
    // Reset button state after any in-flight action fails so the operator
    // can retry without the UI staying stuck in a half-disabled state.
    switch (stage_) {
        case Stage::LoggedOut:
            setPhase("login", "error", msg);
            setStage(Stage::LoggedOut);
            break;
        case Stage::LoggedIn:
        case Stage::Selecting:
            setPhase("contest", "error", msg);
            setStage(Stage::LoggedIn);
            break;
        case Stage::Listening:
        case Stage::TokenStreaming:
            setPhase("listen", "error", msg);
            break;
    }
    appendLog(tr("Error: %1").arg(msg), "err");
}

// ── Presentation helpers ────────────────────────────────────────────────

void MainWindow::appendLog(const QString& msg, const QString& tone) {
    QString ts = QDateTime::currentDateTime().toString("HH:mm:ss");
    auto* item = new QListWidgetItem(QString("[%1]  %2").arg(ts, msg));
    if (tone == "ok")   item->setForeground(QColor(Palette::kSuccess));
    else if (tone == "warn") item->setForeground(QColor(Palette::kWarn));
    else if (tone == "err")  item->setForeground(QColor(Palette::kError));
    logView_->addItem(item);
    // Keep the log bounded so long sessions don't grow without limit.
    while (logView_->count() > 2000) delete logView_->takeItem(0);
    logView_->scrollToBottom();
}

void MainWindow::setPhase(const QString& key, const QString& state, const QString& message) {
    auto it = phases_.find(key);
    if (it == phases_.end()) return;
    QString color = Palette::kBgElev2;
    if      (state == "active") color = Palette::kAccent;
    else if (state == "done")   color = Palette::kSuccess;
    else if (state == "error")  color = Palette::kError;
    else if (state == "warn")   color = Palette::kWarn;
    it->dot->setStyleSheet(QString("color: %1; font-size: 18px;").arg(color));
    if (!message.isEmpty()) phaseNote_->setText(message);
}

void MainWindow::resetPhases() {
    for (auto it = phases_.begin(); it != phases_.end(); ++it) {
        it.value().dot->setStyleSheet(
            QString("color: %1; font-size: 18px;").arg(Palette::kBgElev2));
    }
    phaseNote_->setText(tr("Not connected."));
    qsoCount_ = 0;
    qsoCounter_->setText(tr("0 QSOs logged"));
}
