cmake_minimum_required(VERSION 3.16)
project(noctalum-helper-gui-cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 6.2 REQUIRED COMPONENTS Widgets Network WebSockets SerialPort)

add_executable(noctalum-helper-gui
    main.cpp
    mainwindow.cpp
    mainwindow.hpp
    session.cpp
    session.hpp
    profiles.cpp
    profiles.hpp
    rigs.cpp
    rigs.hpp
    rigctld_client.cpp
    rigctld_client.hpp
    probe.cpp
    probe.hpp
    types.hpp
    rig_combobox.cpp
    rig_combobox.hpp
)
target_link_libraries(noctalum-helper-gui PRIVATE
    Qt6::Widgets
    Qt6::Network
    Qt6::WebSockets
    Qt6::SerialPort
)
target_compile_options(noctalum-helper-gui PRIVATE -Wall -Wextra)

install(TARGETS noctalum-helper-gui RUNTIME DESTINATION bin)
