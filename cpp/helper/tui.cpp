// Setup screen for the C++ helper, in ncurses.  Field labels, presets, and
// validation match the Go tview form so the operator sees the same UX.

#include "tui.hpp"
#include "config.hpp"
#include "util.hpp"

#include <algorithm>
#include <cstring>
#include <ncursesw/ncurses.h>
#include <optional>
#include <string>
#include <vector>

namespace nhelper {

namespace {

struct Preset {
    const char* label;
    int model;
    int speed;
};
constexpr Preset kPresets[] = {
    {"IC-7300", 3073, 0},
    {"IC-705",  3085, 0},
    {"Custom",     0, 0},
};

enum FieldKind { kText, kPassword, kInt, kDropdown };

struct Field {
    const char* label;
    FieldKind   kind;
    std::string value;                  // text content (for kInt: as a string)
    std::vector<std::string> options;   // for kDropdown
    int         option_idx = 0;         // for kDropdown
    int         cursor     = 0;         // caret position within value
};

// Buttons live after all fields in the focus order.
enum { kBtnStart, kBtnQuit, kBtnCount };

// draw_field renders one row at (y, x); highlighted when it has focus.
void draw_field(int y, int x, int w_label, int w_field, const Field& f, bool focused) {
    if (focused) attron(A_REVERSE);
    mvprintw(y, x, "%-*s", w_label, f.label);
    if (focused) attroff(A_REVERSE);

    if (f.kind == kDropdown) {
        std::string shown = f.options.empty() ? std::string("(none)")
                                              : f.options[f.option_idx];
        if (focused) attron(A_UNDERLINE);
        mvprintw(y, x + w_label, "◀ %-*s ▶", w_field - 4, shown.c_str());
        if (focused) attroff(A_UNDERLINE);
    } else {
        std::string shown = f.value;
        if (f.kind == kPassword) shown = std::string(f.value.size(), '*');
        if (focused) attron(A_UNDERLINE);
        mvprintw(y, x + w_label, "%-*s", w_field, shown.c_str());
        if (focused) attroff(A_UNDERLINE);
    }
}

void draw_button(int y, int x, const char* label, bool focused) {
    if (focused) attron(A_REVERSE);
    mvprintw(y, x, " [ %s ] ", label);
    if (focused) attroff(A_REVERSE);
}

bool is_digit_only(const std::string& s) {
    if (s.empty()) return true;
    return std::all_of(s.begin(), s.end(),
        [](unsigned char c) { return std::isdigit(c); });
}

// Modal error popup: draws a centred box, waits for any key, then returns.
void show_error(const std::string& msg) {
    int rows, cols;
    getmaxyx(stdscr, rows, cols);
    int w = std::min<int>(cols - 4, std::max<int>(30, static_cast<int>(msg.size()) + 4));
    int h = 5;
    int y = (rows - h) / 2, x = (cols - w) / 2;
    WINDOW* win = newwin(h, w, y, x);
    box(win, 0, 0);
    mvwprintw(win, 1, 2, "%s", msg.c_str());
    mvwprintw(win, 3, 2, "Press any key");
    wrefresh(win);
    wgetch(win);
    delwin(win);
    touchwin(stdscr);
    refresh();
}

}  // namespace

std::optional<Config> run_tui() {
    Config saved = load_config();
    auto ports = detect_serial_ports();
    bool port_dropdown = !ports.empty();

    // Which preset does the saved rig model match?
    int initial_preset = (sizeof(kPresets) / sizeof(kPresets[0])) - 1;  // "Custom"
    for (size_t i = 0; i < sizeof(kPresets) / sizeof(kPresets[0]); ++i) {
        if (kPresets[i].model != 0 && kPresets[i].model == saved.rig_model) {
            initial_preset = static_cast<int>(i);
            break;
        }
    }
    // For the "Rig Name" default, mirror the Go code: saved name wins, else IC-7300.
    std::string preset_names_owner[3];
    std::vector<std::string> preset_names;
    for (auto& p : kPresets) preset_names.emplace_back(p.label);

    // Build fields in the same visual order as the Go form.
    std::vector<Field> fields;
    // 0 — Preset dropdown
    fields.push_back({"Preset",         kDropdown, {}, preset_names,   initial_preset,           0});
    // 1 — Server URL
    fields.push_back({"Server URL",     kText,     saved.server.empty() ? "http://localhost:8080" : saved.server, {}, 0, 0});
    // 2 — Rig Name
    fields.push_back({"Rig Name",       kText,     saved.name.empty()   ? std::string("IC-7300") : saved.name,       {}, 0, 0});
    // 3 — Helper Token (password)
    fields.push_back({"Helper Token",   kPassword, saved.token,                                                        {}, 0, 0});
    // 4 — Rig Model (int)
    fields.push_back({"Rig Model",      kInt,      saved.rig_model != 0 ? std::to_string(saved.rig_model) : "3073",   {}, 0, 0});
    // 5 — Serial Device (dropdown OR text)
    if (port_dropdown) {
        int idx = 0;
        std::vector<std::string> opts = ports;
        if (!saved.rig_device.empty()) {
            auto it = std::find(opts.begin(), opts.end(), saved.rig_device);
            if (it == opts.end()) { opts.push_back(saved.rig_device); idx = static_cast<int>(opts.size()) - 1; }
            else                  { idx = static_cast<int>(it - opts.begin()); }
        }
        fields.push_back({"Serial Device", kDropdown, {}, opts, idx, 0});
    } else {
        fields.push_back({"Serial Device", kText, saved.rig_device, {}, 0, 0});
    }
    // 6 — Serial Speed (int)
    fields.push_back({"Serial Speed",   kInt,      saved.rig_speed != 0 ? std::to_string(saved.rig_speed) : "",       {}, 0, 0});
    // 7 — rigctld path
    fields.push_back({"rigctld path",   kText,     saved.rigctld_bin.empty() ? default_rigctld_bin() : saved.rigctld_bin, {}, 0, 0});
    // 8 — Interval (ms)
    fields.push_back({"Interval (ms)",  kInt,      saved.interval_ms != 0 ? std::to_string(saved.interval_ms) : "1000", {}, 0, 0});

    // Set caret at end of each text field.
    for (auto& f : fields) f.cursor = static_cast<int>(f.value.size());

    initscr();
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    curs_set(0);

    int focus = 1;  // start on Server URL (Preset is decoration)
    bool submitted = false;
    Config out;

    auto redraw = [&]() {
        erase();
        int rows, cols; getmaxyx(stdscr, rows, cols);
        std::string title = std::string(" Noctalum Helper v") + kHelperVersion + " ";
        int tx = (cols - static_cast<int>(title.size())) / 2;
        attron(A_BOLD);
        mvprintw(0, tx, "%s", title.c_str());
        attroff(A_BOLD);
        mvhline(1, 2, ACS_HLINE, cols - 4);

        int w_label = 16, w_field = std::min(60, cols - w_label - 6);
        int y = 3, x = 4;
        for (size_t i = 0; i < fields.size(); ++i) {
            draw_field(y + static_cast<int>(i), x, w_label, w_field, fields[i], static_cast<int>(i) == focus);
        }
        int by = y + static_cast<int>(fields.size()) + 1;
        draw_button(by, x,          "Start", focus == static_cast<int>(fields.size()));
        draw_button(by, x + 12,     "Quit",  focus == static_cast<int>(fields.size()) + 1);

        mvprintw(rows - 2, 2, "Tab/Shift-Tab: move  •  Enter: activate  •  Esc: quit");
        refresh();
    };

    auto apply_preset = [&](int idx) {
        // 0 = Preset dropdown itself, indices below reference the field list.
        const Preset& p = kPresets[idx];
        if (p.model == 0) return;   // "Custom" leaves everything alone
        fields[2].value = p.label;                                 // Rig Name
        fields[2].cursor = static_cast<int>(fields[2].value.size());
        fields[4].value = std::to_string(p.model);                 // Rig Model
        fields[4].cursor = static_cast<int>(fields[4].value.size());
        fields[6].value = p.speed != 0 ? std::to_string(p.speed) : ""; // Serial Speed
        fields[6].cursor = static_cast<int>(fields[6].value.size());
    };

    auto try_submit = [&]() -> bool {
        auto& server = fields[1].value;
        auto& name   = fields[2].value;
        auto& token  = fields[3].value;
        if (server.empty()) { show_error("Server URL is required."); return false; }
        if (name.empty())   { show_error("Rig Name is required.");   return false; }
        if (token.empty())  { show_error("Helper Token is required."); return false; }

        int model = fields[4].value.empty() ? 0 : std::atoi(fields[4].value.c_str());
        int speed = fields[6].value.empty() ? 0 : std::atoi(fields[6].value.c_str());
        int interval = fields[8].value.empty() ? 1000 : std::atoi(fields[8].value.c_str());
        if (interval < 250) interval = 250;

        std::string device;
        if (fields[5].kind == kDropdown) {
            if (!fields[5].options.empty()) device = fields[5].options[fields[5].option_idx];
        } else {
            device = fields[5].value;
        }

        out.server      = server;
        out.name        = name;
        out.token       = token;
        out.rig_model   = model;
        out.rig_device  = device;
        out.rig_speed   = speed;
        out.rigctld_bin = fields[7].value;
        out.interval_ms = interval;
        save_config(out);
        submitted = true;
        return true;
    };

    // Simple text-edit helper: apply a keypress to the focused text/int field.
    auto text_edit = [&](Field& f, int key) {
        if (key == KEY_BACKSPACE || key == 127 || key == 8) {
            if (f.cursor > 0) {
                f.value.erase(f.cursor - 1, 1);
                --f.cursor;
            }
        } else if (key == KEY_DC) {
            if (f.cursor < static_cast<int>(f.value.size())) f.value.erase(f.cursor, 1);
        } else if (key == KEY_LEFT)  { if (f.cursor > 0) --f.cursor; }
        else if (key == KEY_RIGHT) { if (f.cursor < static_cast<int>(f.value.size())) ++f.cursor; }
        else if (key == KEY_HOME)  { f.cursor = 0; }
        else if (key == KEY_END)   { f.cursor = static_cast<int>(f.value.size()); }
        else if (key >= 32 && key < 127) {
            char c = static_cast<char>(key);
            if (f.kind == kInt && !std::isdigit(static_cast<unsigned char>(c))) return;
            f.value.insert(f.cursor, 1, c);
            ++f.cursor;
        }
    };

    while (!submitted) {
        redraw();
        int key = getch();

        if (key == 27) break;  // Esc — quit unsaved

        // Tab / Shift-Tab / arrows navigate focus.
        int total = static_cast<int>(fields.size()) + kBtnCount;
        if (key == '\t' || key == KEY_DOWN) { focus = (focus + 1) % total; continue; }
        if (key == KEY_BTAB || key == KEY_UP)   { focus = (focus - 1 + total) % total; continue; }

        // Button activation.
        if (focus == static_cast<int>(fields.size()) + kBtnStart && (key == '\n' || key == KEY_ENTER || key == ' ')) {
            if (try_submit()) break;
            continue;
        }
        if (focus == static_cast<int>(fields.size()) + kBtnQuit && (key == '\n' || key == KEY_ENTER || key == ' ')) {
            break;
        }

        // Field editing.
        if (focus >= 0 && focus < static_cast<int>(fields.size())) {
            Field& f = fields[focus];
            if (f.kind == kDropdown) {
                if (key == KEY_LEFT || key == '-') {
                    if (!f.options.empty()) f.option_idx = (f.option_idx - 1 + f.options.size()) % f.options.size();
                    if (focus == 0) apply_preset(f.option_idx);
                }
                else if (key == KEY_RIGHT || key == '+' || key == '\n' || key == ' ' || key == KEY_ENTER) {
                    if (!f.options.empty()) f.option_idx = (f.option_idx + 1) % f.options.size();
                    if (focus == 0) apply_preset(f.option_idx);
                }
            } else {
                if (key == '\n' || key == KEY_ENTER) {
                    // Enter in a text field: advance focus.
                    focus = (focus + 1) % total;
                } else {
                    text_edit(f, key);
                }
            }
        }
    }

    endwin();
    if (submitted) return out;
    return std::nullopt;
}

}  // namespace nhelper
