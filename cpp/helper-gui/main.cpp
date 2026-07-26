// noctalum-helper-gui (C++) — Qt6 Widgets port of cmd/helper-gui.
// Runs a native GUI instead of Wails/WebKit; distributed as a Linux AppImage.

#include "mainwindow.hpp"

#include <QApplication>

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    app.setOrganizationName("Noctalum");
    app.setApplicationName("noctalum-helper-gui");
    app.setApplicationDisplayName("Noctalum Helper");

    MainWindow w;
    w.show();
    return app.exec();
}
