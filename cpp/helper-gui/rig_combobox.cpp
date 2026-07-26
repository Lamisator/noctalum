#include "rig_combobox.hpp"

#include <QCompleter>
#include <QSortFilterProxyModel>
#include <QStandardItemModel>

RigCombobox::RigCombobox(QWidget* parent) : QComboBox(parent) {
    setEditable(true);
    setInsertPolicy(QComboBox::NoInsert);
    setMinimumWidth(240);

    connect(this, QOverload<int>::of(&QComboBox::currentIndexChanged),
            [this](int idx) {
        if (idx >= 0 && idx < rigs_.size()) emit rigChosen(rigs_[idx]);
    });
}

void RigCombobox::set_rigs(const QVector<RigPreset>& rigs) {
    rigs_ = rigs;
    clear();
    for (const auto& r : rigs_) {
        addItem(QString("%1 %2  [%3]").arg(r.vendor, r.label).arg(r.model));
    }

    // Case-insensitive substring completer over the full item text (vendor +
    // label + model), so typing "7300" or "icom" or "IC-73" all filter down.
    auto* completer = new QCompleter(this);
    completer->setModel(model());
    completer->setCaseSensitivity(Qt::CaseInsensitive);
    completer->setFilterMode(Qt::MatchContains);
    completer->setCompletionMode(QCompleter::PopupCompletion);
    setCompleter(completer);
}

void RigCombobox::select_by_model(int model) {
    for (int i = 0; i < rigs_.size(); ++i) {
        if (rigs_[i].model == model) { setCurrentIndex(i); return; }
    }
}

RigPreset RigCombobox::selected() const {
    int idx = currentIndex();
    if (idx >= 0 && idx < rigs_.size()) return rigs_[idx];
    return {};
}
