#include "mainwindow.hpp"
#include "profiles.hpp"
#include "rig_combobox.hpp"
#include "rigs.hpp"
#include "session.hpp"

#include <QApplication>
#include <QCheckBox>
#include <QComboBox>
#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QFormLayout>
#include <QGridLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QInputDialog>
#include <QIntValidator>
#include <QLabel>
#include <QLineEdit>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QScrollBar>
#include <QSerialPortInfo>
#include <QStandardPaths>
#include <QStringList>
#include <QTableWidget>
#include <QTableWidgetItem>
#include <QVBoxLayout>

namespace {
constexpr const char* kAppVersion = "0.1.0";

// Wrap a widget in a QGroupBox that renders like the CSS "card": a bordered
// panel with a small title.  Consistent visual grouping matches the original.
QGroupBox* card(const QString& title, QLayout* body) {
    auto* g = new QGroupBox(title);
    g->setLayout(body);
    return g;
}

// Locate a rigctld on PATH; returns "rigctld" (bare) if we can't find it,
// same behaviour as the Go GUI's DefaultRigctldBin().  Uses Qt's per-OS
// PATH separator (':' on POSIX, ';' on Windows) and appends ".exe" on
// Windows so the Windows build actually finds the Hamlib installer's
// rigctld.exe.
QString default_rigctld_bin() {
    const QString exe =
#ifdef Q_OS_WIN
        "rigctld.exe";
#else
        "rigctld";
#endif
    for (const auto& dir : qEnvironmentVariable("PATH").split(QDir::listSeparator(), Qt::SkipEmptyParts)) {
        QFileInfo fi(dir + "/" + exe);
        if (fi.isExecutable()) return fi.absoluteFilePath();
    }
    return exe;
}
}  // namespace

MainWindow::MainWindow(QWidget* parent) : QMainWindow(parent) {
    setWindowTitle(QString("Noctalum Helper (C++) — v%1").arg(kAppVersion));
    resize(960, 780);
    setMinimumSize(720, 640);

    build_ui();
    refresh_ports();
    refresh_rigs();

    // Load saved profiles and select last-used one.
    store_ = Profiles::load();
    profile_select_->clear();
    for (const auto& p : store_.profiles) profile_select_->addItem(p.name);
    if (!store_.lastUsed.isEmpty()) {
        int idx = profile_select_->findText(store_.lastUsed);
        if (idx >= 0) profile_select_->setCurrentIndex(idx);
    }
}

// ── UI construction ─────────────────────────────────────────────────────

void MainWindow::build_ui() {
    auto* central = new QWidget();
    auto* root = new QVBoxLayout(central);
    root->setContentsMargins(16, 16, 16, 16);
    root->setSpacing(12);
    setCentralWidget(central);

    // ── Topbar ──
    {
        auto* bar = new QHBoxLayout();
        auto* brand = new QLabel(QString("<b>Noctalum</b>&middot;Helper"));
        brand->setTextFormat(Qt::RichText);
        auto* version = new QLabel(QString("v%1 (C++)").arg(kAppVersion));
        version->setStyleSheet("color: #888;");
        bar->addWidget(brand);
        bar->addStretch();
        bar->addWidget(version);
        root->addLayout(bar);
    }

    // ── Profile bar ──
    {
        profile_select_    = new QComboBox();
        profile_select_->setMinimumWidth(240);
        btn_new_profile_   = new QPushButton("New");
        btn_save_profile_  = new QPushButton("Save");
        btn_delete_profile_= new QPushButton("Delete");

        auto* h = new QHBoxLayout();
        h->addWidget(new QLabel("Profile:"));
        h->addWidget(profile_select_, 1);
        h->addWidget(btn_new_profile_);
        h->addWidget(btn_save_profile_);
        h->addWidget(btn_delete_profile_);
        root->addWidget(card("Profile", h));

        connect(profile_select_, QOverload<int>::of(&QComboBox::currentIndexChanged),
                this, &MainWindow::on_profile_changed);
        connect(btn_new_profile_,    &QPushButton::clicked, this, &MainWindow::on_new_profile);
        connect(btn_save_profile_,   &QPushButton::clicked, this, &MainWindow::on_save_profile);
        connect(btn_delete_profile_, &QPushButton::clicked, this, &MainWindow::on_delete_profile);
    }

    // ── Phase row ──
    {
        auto* row = new QHBoxLayout();
        for (const auto& [phase, human] : std::vector<std::pair<QString, QString>>{
                 {"model",      "Detecting model"},
                 {"baud",       "Testing baud"},
                 {"connecting", "Connecting"},
                 {"connected",  "Connected"}}) {
            auto* icon  = new QLabel("○");
            icon->setStyleSheet("font-size: 18px;");
            auto* label = new QLabel(human);
            auto* col = new QVBoxLayout();
            col->setAlignment(Qt::AlignCenter);
            col->addWidget(icon,  0, Qt::AlignCenter);
            col->addWidget(label, 0, Qt::AlignCenter);
            row->addLayout(col, 1);
            phases_[phase] = {icon, label};
        }
        phase_message_ = new QLabel("Click Connect to start.");
        phase_message_->setStyleSheet("color: #666; padding-top: 4px;");
        phase_message_->setAlignment(Qt::AlignCenter);

        auto* v = new QVBoxLayout();
        v->addLayout(row);
        v->addWidget(phase_message_);
        root->addWidget(card("Progress", v));
    }

    // ── Controls ──
    {
        auto_detect_model_ = new QCheckBox("Auto-detect rig model && baud (tries every Hamlib model — slow)");
        auto_detect_baud_  = new QCheckBox("Auto-detect baud rate (rig model + serial device must be set)");
        auto_detect_baud_->setChecked(true);

        btn_connect_    = new QPushButton("Connect");
        btn_disconnect_ = new QPushButton("Disconnect");
        btn_disconnect_->setEnabled(false);

        auto* toggles = new QVBoxLayout();
        toggles->addWidget(auto_detect_model_);
        toggles->addWidget(auto_detect_baud_);
        auto* buttons = new QHBoxLayout();
        buttons->addStretch();
        buttons->addWidget(btn_connect_);
        buttons->addWidget(btn_disconnect_);
        toggles->addLayout(buttons);
        root->addWidget(card("Connect", toggles));

        connect(auto_detect_model_, &QCheckBox::toggled, this, &MainWindow::on_auto_detect_model_toggled);
        connect(btn_connect_,       &QPushButton::clicked, this, &MainWindow::on_connect);
        connect(btn_disconnect_,    &QPushButton::clicked, this, &MainWindow::on_disconnect);
    }

    // ── Configuration form ──
    {
        cfg_name_              = new QLineEdit();
        cfg_name_->setPlaceholderText("e.g. Shack IC-7300");
        cfg_server_            = new QLineEdit();
        cfg_server_->setPlaceholderText("https://noctalum.example.org");
        cfg_token_             = new QLineEdit();
        cfg_token_->setEchoMode(QLineEdit::Password);
        cfg_token_->setPlaceholderText("from Noctalum → Settings");
        cfg_rig_name_          = new QLineEdit();
        cfg_rig_name_->setPlaceholderText("IC-7300");
        cfg_rig_model_         = new RigCombobox();
        cfg_rig_model_custom_  = new QLineEdit();
        cfg_rig_model_custom_->setPlaceholderText("override");
        cfg_rig_model_custom_->setValidator(new QIntValidator(0, 999999, this));
        cfg_rig_device_        = new QComboBox();
        cfg_rig_device_custom_ = new QLineEdit();
        cfg_rig_device_custom_->setPlaceholderText("/dev/ttyUSB0");
        cfg_rig_speed_         = new QComboBox();
        cfg_rig_speed_->addItem("auto", 0);
        for (int b : {4800, 9600, 19200, 38400, 57600, 115200})
            cfg_rig_speed_->addItem(QString::number(b), b);
        cfg_rigctld_bin_       = new QLineEdit(default_rigctld_bin());
        cfg_interval_          = new QLineEdit("1000");
        cfg_interval_->setValidator(new QIntValidator(250, 60000, this));

        auto* grid = new QGridLayout();
        int r = 0;
        auto put = [&](const QString& lbl, QWidget* w1, QWidget* w2 = nullptr) {
            grid->addWidget(new QLabel(lbl), r, 0);
            grid->addWidget(w1, r, 1);
            if (w2) grid->addWidget(w2, r, 2);
            ++r;
        };
        put("Profile name",             cfg_name_);
        put("Server URL",               cfg_server_);
        put("Helper Token",             cfg_token_);
        put("Rig display name",         cfg_rig_name_);
        put("Rig model (Hamlib)",       cfg_rig_model_, cfg_rig_model_custom_);
        put("Serial device",            cfg_rig_device_, cfg_rig_device_custom_);
        put("Baud rate",                cfg_rig_speed_);
        put("rigctld binary",           cfg_rigctld_bin_);
        put("Polling interval (ms)",    cfg_interval_);

        config_card_ = new QGroupBox("Configuration");
        config_card_->setLayout(grid);
        root->addWidget(config_card_);
    }

    // ── rigctld parameters readout ──
    {
        readout_table_ = new QTableWidget(0, 2);
        readout_table_->setHorizontalHeaderLabels({"", ""});
        readout_table_->horizontalHeader()->setStretchLastSection(true);
        readout_table_->horizontalHeader()->hide();
        readout_table_->verticalHeader()->hide();
        readout_table_->setShowGrid(false);
        readout_table_->setEditTriggers(QAbstractItemView::NoEditTriggers);
        readout_table_->setSelectionMode(QAbstractItemView::NoSelection);
        readout_table_->setFocusPolicy(Qt::NoFocus);

        auto* v = new QVBoxLayout();
        v->addWidget(readout_table_);
        readout_card_ = new QGroupBox("rigctld parameters");
        readout_card_->setLayout(v);
        readout_card_->hide();
        root->addWidget(readout_card_);
    }

    // ── Activity log ──
    {
        log_view_ = new QPlainTextEdit();
        log_view_->setReadOnly(true);
        log_view_->setMaximumBlockCount(2000);
        log_view_->setFont(QFont("monospace"));
        btn_clear_log_ = new QPushButton("Clear");

        auto* head = new QHBoxLayout();
        head->addWidget(new QLabel("Activity log"));
        head->addStretch();
        head->addWidget(btn_clear_log_);
        auto* v = new QVBoxLayout();
        v->addLayout(head);
        v->addWidget(log_view_);

        auto* box = new QGroupBox();
        box->setLayout(v);
        root->addWidget(box, 1);

        connect(btn_clear_log_, &QPushButton::clicked, log_view_, &QPlainTextEdit::clear);
    }
}

void MainWindow::refresh_ports() {
    cfg_rig_device_->clear();
    for (const auto& p : QSerialPortInfo::availablePorts()) {
        cfg_rig_device_->addItem(p.systemLocation());
    }
    if (cfg_rig_device_->count() == 0) cfg_rig_device_->setEnabled(false);
}

void MainWindow::refresh_rigs() {
    // Kick this off synchronously — it's fast unless rigctld is on a slow
    // filesystem, and we want the completer ready before the first paint.
    cfg_rig_model_->set_rigs(all_rigs(cfg_rigctld_bin_->text()));
}

// ── Profile bar ─────────────────────────────────────────────────────────

void MainWindow::on_profile_changed(int idx) {
    if (loading_profile_) return;
    if (idx < 0 || idx >= store_.profiles.size()) return;
    load_profile_into_form(store_.profiles[idx]);
    Profiles::set_last(store_.profiles[idx].name);
    store_.lastUsed = store_.profiles[idx].name;
}

void MainWindow::on_new_profile() {
    bool ok = false;
    QString name = QInputDialog::getText(this, "New profile", "Profile name:",
                                         QLineEdit::Normal, "", &ok);
    if (!ok || name.trimmed().isEmpty()) return;
    Profile p = form_to_profile();
    p.name = name.trimmed();
    store_ = Profiles::upsert(p);
    // Refresh the dropdown and select the new entry.
    loading_profile_ = true;
    profile_select_->clear();
    for (const auto& q : store_.profiles) profile_select_->addItem(q.name);
    profile_select_->setCurrentText(p.name);
    loading_profile_ = false;
}

void MainWindow::on_save_profile() {
    Profile p = form_to_profile();
    if (p.name.isEmpty()) {
        QMessageBox::warning(this, "Save profile", "Enter a profile name first.");
        return;
    }
    store_ = Profiles::upsert(p);
    // Ensure the dropdown reflects the (possibly new) entry.
    loading_profile_ = true;
    profile_select_->clear();
    for (const auto& q : store_.profiles) profile_select_->addItem(q.name);
    profile_select_->setCurrentText(p.name);
    loading_profile_ = false;
    on_log(QString("saved profile \"%1\"").arg(p.name));
}

void MainWindow::on_delete_profile() {
    int idx = profile_select_->currentIndex();
    if (idx < 0 || idx >= store_.profiles.size()) return;
    QString name = store_.profiles[idx].name;
    auto r = QMessageBox::question(this, "Delete profile",
        QString("Really delete profile \"%1\"?").arg(name));
    if (r != QMessageBox::Yes) return;
    store_ = Profiles::remove(name);
    loading_profile_ = true;
    profile_select_->clear();
    for (const auto& q : store_.profiles) profile_select_->addItem(q.name);
    loading_profile_ = false;
}

void MainWindow::load_profile_into_form(const Profile& p) {
    loading_profile_ = true;
    cfg_name_->setText(p.name);
    cfg_server_->setText(p.server);
    cfg_token_->setText(p.token);
    cfg_rig_name_->setText(p.rigName);
    cfg_rig_model_->select_by_model(p.rigModel);
    cfg_rig_model_custom_->setText(p.rigModel == 0 ? QString() : QString::number(p.rigModel));
    // Serial device: pick from dropdown if present, else stash in custom.
    int di = cfg_rig_device_->findText(p.rigDevice);
    if (di >= 0) { cfg_rig_device_->setCurrentIndex(di); cfg_rig_device_custom_->clear(); }
    else         { cfg_rig_device_custom_->setText(p.rigDevice); }
    // Speed: match exact value, else "auto".
    int si = cfg_rig_speed_->findData(p.rigSpeed);
    cfg_rig_speed_->setCurrentIndex(si >= 0 ? si : 0);
    if (!p.rigctldBin.isEmpty()) cfg_rigctld_bin_->setText(p.rigctldBin);
    cfg_interval_->setText(QString::number(p.intervalMs > 0 ? p.intervalMs : 1000));
    auto_detect_baud_->setChecked(p.autoDetect);
    auto_detect_model_->setChecked(p.autoDetectModel);
    loading_profile_ = false;
}

Profile MainWindow::form_to_profile() const {
    Profile p;
    p.name       = cfg_name_->text().trimmed();
    p.server     = cfg_server_->text().trimmed();
    p.token      = cfg_token_->text();
    p.rigName    = cfg_rig_name_->text().trimmed();
    // Custom-model text overrides the combobox selection when non-empty.
    if (!cfg_rig_model_custom_->text().trimmed().isEmpty()) {
        p.rigModel = cfg_rig_model_custom_->text().toInt();
    } else {
        p.rigModel = cfg_rig_model_->selected().model;
    }
    // Custom-device text overrides the dropdown when non-empty.
    p.rigDevice  = !cfg_rig_device_custom_->text().trimmed().isEmpty()
                     ? cfg_rig_device_custom_->text().trimmed()
                     : cfg_rig_device_->currentText();
    p.rigSpeed   = cfg_rig_speed_->currentData().toInt();
    p.rigctldBin = cfg_rigctld_bin_->text().trimmed();
    p.intervalMs = std::max(250, cfg_interval_->text().toInt());
    p.autoDetect      = auto_detect_baud_->isChecked();
    p.autoDetectModel = auto_detect_model_->isChecked();
    return p;
}

ConnectRequest MainWindow::form_to_request() const {
    Profile p = form_to_profile();
    ConnectRequest r;
    r.autoDetect      = p.autoDetect;
    r.autoDetectModel = p.autoDetectModel;
    r.server          = p.server;
    r.token           = p.token;
    r.rigName         = p.rigName;
    r.rigModel        = p.rigModel;
    r.rigDevice       = p.rigDevice;
    r.rigSpeed        = p.rigSpeed;
    r.rigctldBin      = p.rigctldBin;
    r.intervalMs      = p.intervalMs;
    return r;
}

// ── Connect flow ────────────────────────────────────────────────────────

void MainWindow::on_auto_detect_model_toggled(bool on) {
    // Same greyed-out behaviour as the Wails frontend: manual model fields
    // (and the baud auto-detect toggle) become irrelevant when full model
    // auto-detect is on.
    cfg_rig_model_->setEnabled(!on);
    cfg_rig_model_custom_->setEnabled(!on);
    auto_detect_baud_->setEnabled(!on);
}

void MainWindow::on_connect() {
    if (session_) return;  // safety — button should already be disabled

    ConnectRequest r = form_to_request();
    if (r.server.isEmpty())  { QMessageBox::warning(this, "Connect", "Server URL is required."); return; }
    if (r.token.isEmpty())   { QMessageBox::warning(this, "Connect", "Helper token is required."); return; }
    if (r.rigName.isEmpty()) { QMessageBox::warning(this, "Connect", "Rig display name is required."); return; }
    if (!r.autoDetectModel && r.rigModel == 0) {
        QMessageBox::warning(this, "Connect", "Rig model is required (or enable auto-detect).");
        return;
    }

    reset_phases();
    session_ = new Session(r, this);
    connect(session_, &Session::phaseChanged,       this, &MainWindow::on_phase);
    connect(session_, &Session::logLine,            this, &MainWindow::on_log);
    connect(session_, &Session::statusChanged,      this, &MainWindow::on_status);
    connect(session_, &Session::rigctldParamsReady, this, &MainWindow::on_rigctld_params);
    connect(session_, &Session::modelDetected,      this, &MainWindow::on_model_detected);
    connect(session_, &Session::finished,           this, &MainWindow::on_session_finished);
    session_->start();
}

void MainWindow::on_disconnect() {
    if (session_) session_->request_stop();
}

// ── Session signal handlers ─────────────────────────────────────────────

void MainWindow::on_phase(QString phase, QString state, QString message) {
    auto it = phases_.find(phase);
    if (it == phases_.end()) return;
    QString icon = "○";
    QString color = "#666";
    if (state == "active")  { icon = "⟳"; color = "#0aa"; }
    else if (state == "done")     { icon = "✓"; color = "#4c4"; }
    else if (state == "error")    { icon = "✗"; color = "#c44"; }
    else if (state == "skipped")  { icon = "—"; color = "#999"; }
    it->icon->setText(icon);
    it->icon->setStyleSheet(QString("font-size: 18px; color: %1;").arg(color));
    if (!message.isEmpty()) phase_message_->setText(message);
}

void MainWindow::on_log(QString msg) {
    QString ts = QDateTime::currentDateTime().toString("HH:mm:ss");
    log_view_->appendPlainText(QString("[%1] %2").arg(ts, msg));
    auto* bar = log_view_->verticalScrollBar();
    bar->setValue(bar->maximum());
}

void MainWindow::on_status(bool running, QString error) {
    btn_connect_->setEnabled(!running);
    btn_disconnect_->setEnabled(running);
    config_card_->setEnabled(!running);
    if (!error.isEmpty()) on_log("error: " + error);
}

void MainWindow::on_rigctld_params(RigctldParams p) {
    readout_card_->show();
    readout_table_->setRowCount(0);
    auto add = [&](const QString& k, const QString& v) {
        int r = readout_table_->rowCount();
        readout_table_->insertRow(r);
        readout_table_->setItem(r, 0, new QTableWidgetItem(k));
        readout_table_->setItem(r, 1, new QTableWidgetItem(v));
    };
    add("binary",    p.binary);
    add("model",     QString::number(p.model));
    add("rig",       p.rigLabel);
    add("device",    p.device);
    add("speed",     p.speed == 0 ? QString("(default)") : QString::number(p.speed));
    add("host:port", QString("%1:%2").arg(p.host).arg(p.port));
    add("argv",      p.args);
    readout_table_->resizeColumnsToContents();
}

void MainWindow::on_model_detected(int model, QString label, int baud) {
    cfg_rig_model_->select_by_model(model);
    cfg_rig_speed_->setCurrentIndex(std::max(0, cfg_rig_speed_->findData(baud)));
    on_log(QString("detected %1 (model %2) at %3 baud").arg(label).arg(model).arg(baud));
}

void MainWindow::on_session_finished() {
    if (session_) { session_->deleteLater(); session_ = nullptr; }
    btn_connect_->setEnabled(true);
    btn_disconnect_->setEnabled(false);
    config_card_->setEnabled(true);
}

void MainWindow::reset_phases() {
    for (auto it = phases_.begin(); it != phases_.end(); ++it) {
        it.value().icon->setText("○");
        it.value().icon->setStyleSheet("font-size: 18px; color: #666;");
    }
    phase_message_->setText("Starting…");
    readout_card_->hide();
}
