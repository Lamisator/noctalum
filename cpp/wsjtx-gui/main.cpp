// noctalum-wsjtx-gui — cross-platform Qt6 GUI for the WSJT-X → Noctalum
// bridge.  Same responsibilities as cpp/wsjtx (login, contest pick, UDP
// LOG_QSO forwarding) but with a native window, optional credential
// caching, and the Noctalum dark theme.
//
// Builds and runs on Linux (AppImage), macOS (.app bundle), and Windows
// (.exe) — no runtime plugins, no HTML/JS layer.

#include "mainwindow.hpp"

#include <QApplication>

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    app.setOrganizationName("Noctalum");
    app.setApplicationName("noctalum-wsjtx-gui");
    app.setApplicationDisplayName("Noctalum WSJT-X Bridge");

    // Force the Fusion base style so the QSS rules render identically on
    // all three OSes (macOS's default style ignores several selectors).
    app.setStyle("Fusion");

    MainWindow w;
    w.show();
    return app.exec();
}
