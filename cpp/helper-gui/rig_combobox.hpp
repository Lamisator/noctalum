#pragma once

#include "types.hpp"

#include <QComboBox>
#include <QVector>

// Editable combobox with substring filtering across vendor + label + model.
// Setting the rig list triggers a re-population; select_by_model() looks up
// a rig by Hamlib model number and picks it in the dropdown.
class RigCombobox : public QComboBox {
    Q_OBJECT
public:
    explicit RigCombobox(QWidget* parent = nullptr);

    void set_rigs(const QVector<RigPreset>& rigs);
    void select_by_model(int model);

    // Returns the currently-selected rig (from the current index) or an
    // all-zero RigPreset when nothing is selected.
    RigPreset selected() const;

signals:
    void rigChosen(RigPreset r);

private:
    QVector<RigPreset> rigs_;
};
