#pragma once

#include "common.hpp"
#include <optional>

namespace nhelper {

// Interactive setup form.  Returns the config on Start; std::nullopt if the
// operator Quit-s (or hits Esc).  Persists the result via save_config() before
// returning, matching the Go tview flow.
std::optional<Config> run_tui();

}  // namespace nhelper
