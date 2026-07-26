cmake_minimum_required(VERSION 3.16)
project(noctalum-helper-cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(nlohmann_json REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(LWS REQUIRED libwebsockets)

find_library(NCURSES_LIB ncursesw REQUIRED)
find_path(NCURSES_INCLUDE_DIR ncurses.h PATH_SUFFIXES ncursesw)

add_executable(noctalum-helper
    main.cpp
    session.cpp
    rigctld.cpp
    ws.cpp
    tui.cpp
    util.cpp
    config.cpp
)
target_include_directories(noctalum-helper PRIVATE ${LWS_INCLUDE_DIRS} ${NCURSES_INCLUDE_DIR})
target_link_directories(noctalum-helper PRIVATE ${LWS_LIBRARY_DIRS})
target_link_libraries(noctalum-helper PRIVATE nlohmann_json::nlohmann_json ${LWS_LIBRARIES} ${NCURSES_LIB})
target_compile_options(noctalum-helper PRIVATE -Wall -Wextra ${LWS_CFLAGS_OTHER})

install(TARGETS noctalum-helper RUNTIME DESTINATION bin)
