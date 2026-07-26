cmake_minimum_required(VERSION 3.16)
project(noctalum-wsjtx-cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(CURL REQUIRED)
find_package(nlohmann_json REQUIRED)

add_executable(noctalum-wsjtx main.cpp)
target_link_libraries(noctalum-wsjtx PRIVATE CURL::libcurl nlohmann_json::nlohmann_json)
target_compile_options(noctalum-wsjtx PRIVATE -Wall -Wextra)

install(TARGETS noctalum-wsjtx RUNTIME DESTINATION bin)
