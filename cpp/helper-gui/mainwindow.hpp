#pragma once

#include "types.hpp"

#include <QMainWindow>
#include <QMap>

class QComboBox;
class QCheckBox;
class QLineEdit;
class QPushButton;
class QPlainTextEdit;
class QTableWidget;
class QLabel;
class QGroupBox;

class Session;
class RigCombobox;

// The whole Qt UI in one class.  We build it programmatically (no .ui XML)
// so the layout tracks the original Wails HTML by section rather than by
// generated names.
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(QWidget* parent = nullptr);

private slots:
    // Profile bar
    void on_profile_changed(int idx);
    void on_new_profile();
    void on_save_profile();
    void on_delete_profile();

    // Auto-detect toggle: mirrors the frontend's "greyed out" behaviour for
    // manual fields when the operator opts into full model auto-detect.
    void on_auto_detect_model_toggled(bool on);

    // Connect flow
    void on_connect();
    void on_disconnect();

    // Session signals
    void on_phase(QString phase, QString state, QString message);
    void on_log(QString msg);
    void on_status(bool running, QString error);
    void on_rigctld_params(RigctldParams p);
    void on_model_detected(int model, QString label, int baud);
    void on_session_finished();

private:
    void build_ui();
    void refresh_ports();
    void refresh_rigs();
    void load_profile_into_form(const Profile& p);
    Profile form_to_profile() const;
    ConnectRequest form_to_request() const;
    void reset_phases();

    // Profile bar
    QComboBox*    profile_select_ = nullptr;
    QPushButton*  btn_new_profile_ = nullptr;
    QPushButton*  btn_save_profile_ = nullptr;
    QPushButton*  btn_delete_profile_ = nullptr;

    // Phase row
    struct PhaseWidgets { QLabel* icon; QLabel* label; };
    QMap<QString, PhaseWidgets> phases_;
    QLabel*       phase_message_ = nullptr;

    // Controls
    QCheckBox*    auto_detect_model_ = nullptr;
    QCheckBox*    auto_detect_baud_ = nullptr;
    QPushButton*  btn_connect_ = nullptr;
    QPushButton*  btn_disconnect_ = nullptr;

    // Config form
    QLineEdit*    cfg_name_ = nullptr;
    QLineEdit*    cfg_server_ = nullptr;
    QLineEdit*    cfg_token_ = nullptr;
    QLineEdit*    cfg_rig_name_ = nullptr;
    RigCombobox*  cfg_rig_model_ = nullptr;
    QLineEdit*    cfg_rig_model_custom_ = nullptr;
    QComboBox*    cfg_rig_device_ = nullptr;
    QLineEdit*    cfg_rig_device_custom_ = nullptr;
    QComboBox*    cfg_rig_speed_ = nullptr;
    QLineEdit*    cfg_rigctld_bin_ = nullptr;
    QLineEdit*    cfg_interval_ = nullptr;
    QGroupBox*    config_card_ = nullptr;

    // Readout + log
    QGroupBox*    readout_card_ = nullptr;
    QTableWidget* readout_table_ = nullptr;
    QPlainTextEdit* log_view_ = nullptr;
    QPushButton*  btn_clear_log_ = nullptr;

    // State
    ProfileStore  store_;
    Session*      session_ = nullptr;
    bool          loading_profile_ = false;  // guard against on_profile_changed feedback loops
};
