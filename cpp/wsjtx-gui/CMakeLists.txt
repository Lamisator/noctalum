cmake_minimum_required(VERSION 3.16)
project(noctalum-wsjtx-gui LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

# Qt6 Widgets + Network is enough — no WebSockets or SerialPort required, so
# the runtime footprint on Linux/macOS/Windows stays small and the source
# tree carries no third-party dependencies beyond Qt itself.
find_package(Qt6 6.2 REQUIRED COMPONENTS Widgets Network)

add_executable(noctalum-wsjtx-gui WIN32 MACOSX_BUNDLE
    main.cpp
    mainwindow.cpp
    mainwindow.hpp
    session.cpp
    session.hpp
    credentials.cpp
    credentials.hpp
    wsjtx_protocol.cpp
    wsjtx_protocol.hpp
    types.hpp
)
target_link_libraries(noctalum-wsjtx-gui PRIVATE
    Qt6::Widgets
    Qt6::Network
)
target_compile_options(noctalum-wsjtx-gui PRIVATE -Wall -Wextra)

# macOS bundle metadata — matches the display name shown in the Dock.
set_target_properties(noctalum-wsjtx-gui PROPERTIES
    MACOSX_BUNDLE_BUNDLE_NAME          "Noctalum WSJT-X Bridge"
    MACOSX_BUNDLE_GUI_IDENTIFIER       "org.noctalum.wsjtx-gui"
    MACOSX_BUNDLE_BUNDLE_VERSION       "0.1.0"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "0.1.0"
)

install(TARGETS noctalum-wsjtx-gui
    RUNTIME DESTINATION bin
    BUNDLE  DESTINATION .
)
