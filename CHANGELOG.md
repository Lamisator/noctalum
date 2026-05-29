# Noctalum Changelog

## v0.51 — 2026-05-29 — Telegram notification after deploy

- New `cmd/notify-telegram/main.go` — small Go binary that reads the top entry of the `CHANGELOG` array in `internal/server/web/app.js`, cross-checks its version against `programVersion` in `internal/server/server.go`, and posts the German body to a configured Telegram group via the Bot HTTPS API
- `build.sh` cross-compiles it to `dist/noctalum-notify-telegram-<os>-<arch>` for the operator's laptop (defaults: `linux/amd64`, `darwin/arm64`). A new `--notifier-only` flag iterates on the notifier without rebuilding everything else
- `deploy.sh` runs the notifier after the final `docker compose up -d` and selects the right host binary via `uname`. Failures are non-fatal (`|| true`) — and the notifier itself never exits non-zero outside `--setup`, so a Telegram outage cannot block a deploy
- Configuration lives in `~/.config/noctalum/telegram.json` (chmod 0600, refuses to load if perms are wider). Override via `NOCTALUM_TELEGRAM_CONFIG`. First-time setup is interactive: `./dist/noctalum-notify-telegram-<host> --setup` prompts for the bot token (hidden via `golang.org/x/term`), validates it with `getMe`, long-polls `getUpdates` until the operator adds the bot to a group and sends a message, confirms the detected `chat_id`, posts a German test message, and persists the config
- Duplicate-post prevention: `last_posted_version` is recorded in the config after each successful post; a normal run skips with a stderr note when the version matches. `--force` reposts, `--dry-run` previews to stdout without touching state or Telegram, `--version 0.42` picks a specific older entry
- Messages render with Telegram MarkdownV2 (bold version header + `🌙` moon glyph + escaped German body) and truncate at the last sentence boundary at a UTF-8-safe rune boundary if a single entry exceeds Telegram's 4096-char limit
- `programVersion` bumped to `0.51`

## v0.50 — 2026-05-24 — "NR given" form field refreshes on QSO delete/insert

- The auto-fill in `updateNrPreview` (`internal/server/web/app.js:2494`) only wrote to `q-nr-sent` when the field was empty — so once filled, subsequent WS `qso`/`qso_deleted`/`qso_updated` events left the displayed number stale even though the underlying next-NR had changed. The server still assigned the correct number at log time, but the operator saw a value that was already in use or had just been freed
- New module-level flag `nrSentAutoFilled` tracks whether the field currently holds an auto-filled preview vs. a value the operator typed. `updateNrPreview` now refreshes the field when it's empty OR when it still holds the auto-filled preview. An `input` listener on `q-nr-sent` clears the flag the moment the operator types, so typed values are never overwritten
- Programmatic `field.value = preview` assignments don't trigger the `input` event, so the listener fires only on real keystrokes

## v0.49 — 2026-05-24 — NR counter recycles freed numbers on QSO delete

- `handleQSOByID` DELETE branch in `internal/server/server.go` now resets `s.nrNext[contestID]` to `MaxNrSent(contestID) + 1` under `nrMu` after the row is removed. Previously the in-memory counter only ever incremented, so deleting the top-most QSO left a gap — the next insert reused the *old* (higher) value instead of the freed one
- The frontend `updateNrPreview` (`internal/server/web/app.js:2490`) already recomputes from the local `qsos` array on the `qso_deleted` WS event and only fills the field if it's empty (`!field.value`) — an operator mid-entry therefore keeps their pre-filled number, and the server's atomic assignment at log time hands out whichever number is current
- `programVersion` bumped to `0.49` (was stale at `0.46` — `v0.47` and `v0.48` forgot to bump it; this entry catches it up to today's release)

## v0.48 — 2026-05-22 — Fixed typos

## v0.47 — 2026-05-22 — Credits footer on the contest picker

- New `<footer class="app-credits">` at the bottom of `#contest-screen`, rendered via `data-i18n-html` so each language ships its own sentence with the two embedded links
- Text acknowledges DM2LAP + Claude (with the DARC O35 club), states the GPLv3 license, links source code to https://github.com/Lamisator/noctalum, and links donations to https://panthera.org
- `.contest-screen-body` switched from a centred-row flex container to a centred-column one so the credits footer sits below the contest layout (using the same 1800 px max-width cap, so it visually aligns with the picker on wide screens)

## v0.46 — 2026-05-22 — PDF footer carries the current app version

- `programVersion` in `internal/server/server.go` was last touched at `0.3.0` and was therefore many releases stale. Bumped to the current `0.46` and the constant is now explicitly documented as the mirror of the top CHANGELOG entry — bump it together going forward
- PDF footer string changed from `"Noctalum " + programVersion` to `"Noctalum v" + programVersion` to match how the changelog displays versions
- The footer is already wired through `pdf.SetFooterFunc`, so it appears in the bottom-left of every page (and updates with `{nb}` placeholder for the page count on the right)

## v0.45 — 2026-05-22 — Cluster-spot click stashes the typed callsign, not the clicked one

- `useClusterSpot(spot)` previously called `cancelQsoEdit()` first (clearing the form), then wrote the spot's callsign, then tuned the rig. The subsequent `rigs` WebSocket broadcast saw the freq move and ran `stashCurrentForm()` — by that point the form already held the spot's callsign, so the stash captured the wrong call
- Fix: lift the same pattern `recallStash()` already uses
  - Stash the current form contents up front (only when `q-call` is non-empty and we're not editing) using `lastRigFreqs[selected_rig]` as the `freqOverrideHz`, so the stash records the rig freq from before the QSY
  - Pre-set `lastRigFreqs[selected_rig] = freqHz` right after submitting the `set_freq` request, so the resulting `rigs` broadcast sees no delta and won't fire a second stash for the spot data we just wrote

## v0.44 — 2026-05-22 — Unified "Noctalum" wordmark across topbars

- `.topbar .brand` rule extended to also match `.contest-topbar .brand`
- Same change applied to the `max-width: 480px` font-size override and the `body.mobile-mode` font-size override so the two wordmarks stay in sync at every viewport

## v0.43 — 2026-05-22 — Full-width contest picker

- `.contest-screen-layout` is now `width: 100 %; max-width: 1800 px;` instead of shrinking to content
- `#contest-screen .login-card { flex: 1 }` was already in place, so the middle pill absorbs the extra space while the left nav-pill and the right Online-Now panel keep their natural widths

## v0.42 — 2026-05-22 — UTF-8 BOM on CSV export so Excel renders umlauts

- `ExportCSV` writes the three-byte sequence `EF BB BF` before the header row
- Excel uses the BOM to detect UTF-8; without it the file was decoded as the local code page (CP1252 on most Windows installs) which turns `ä` into `Ã¤`, etc.
- HTTP response header was already `text/csv; charset=utf-8`; Excel ignores that header when opening a downloaded file, hence the in-file BOM

## v0.41 — 2026-05-22 — Edit QSO loads custom-field values

- `loadQsoIntoForm(q)` now parses `q.extras` (JSON keyed by custom-field `name`) and calls `applyCustomFieldsValues()` — the same path the stash flow uses
- Affects all custom-field types but is most visible for `select` (dropdown) fields, which previously showed their first (empty) option in the Edit QSO mask even though the QSO had a value stored

## v0.40 — 2026-05-22 — Smiling face for the Users menu pill

- Icon glyph swapped from `&#9785;` (☹) to `&#9786;` (☺)

## v0.39 — 2026-05-22 — Clear-filter pill in QSO history

- Red "× Filter" button pill sits left of the `history-filter` input
- Hidden by default; shown whenever the text filter has content or `callsignFilter` is set
- Clicking it resets both `$('history-filter').value` and `callsignFilter` and re-renders the QSO table
- `updateFilterClearPill()` is invoked from `renderQsos()` so the pill stays in sync with whichever path activated the filter (typing, clicking a row, accepting a cluster spot, …)

## v0.38 — 2026-05-22 — PDF cells wrap long text instead of truncating

- Body rows now pre-split each cell via `pdf.SplitLines` to compute how many wrapped lines it needs, then size the row to the tallest cell
- The cell background (zebra stripe) is filled across the full row height first, then each text line is drawn at the correct Y offset; left/right borders are drawn explicitly per cell so they span the multi-line row
- A manual page-break check sits in front of each row because the multi-line layout drives Y growth itself and the auto page-break heuristic would otherwise miss it
- Result: long Notes, Names, or custom-field values like a multi-word event description stay legible and don't bleed past the right-hand border

## v0.37 — 2026-05-22 — PDF column titles left-aligned

- `pdf.CellFormat` for the table header row now uses align "L" instead of "C", so column titles sit at the same horizontal position as the cells below them

## v0.36 — 2026-05-22 — PDF report export + column picker

- New `GET /api/export/pdf?cols=key1,key2,…` endpoint generates an A4-landscape report
- Header: Noctalum logo + brand on the left; contest name, station call, QTH, QSO count and generation timestamp on the right; blue accent rule beneath
- Table header repeats on every page (gofpdf `SetHeaderFunc`); rows are zebra-striped; numeric columns are right-aligned, band/mode/zone columns centre-aligned
- Column widths are computed from per-column "natural" widths and scaled so the row exactly fills the page
- Helvetica strings go through a cp1252 unicode translator so `Ø`, `·`, and German umlauts render correctly rather than as mojibake
- Export tab gains a "PDF report" card with a column picker; checkboxes default to the columns currently visible in Past QSOs and write `?cols=…` into the download URL, preserving the contest's saved column order
- Built-in column labels are localised on the server (EN/DE); custom-field columns use the label configured in the contest

## v0.35 — 2026-05-22 — New-QSO time field becomes a date-and-time picker

- `<input id="q-time">` switched from `type="time"` to `type="datetime-local"` so the optional time field now exposes a date as well — back-log a QSO that happened on a different day without leaving the form
- Form submit assembles `YYYY-MM-DDTHH:MM:SS` (UTC) directly from the input instead of stitching it together from a separate `dataset.date` field
- Edit flow pre-fills both date and time from the QSO's UTC timestamp

## v0.34 — 2026-05-22 — Mobile mode (auto-engages on phones)

- New `body.mobile-mode` class auto-applied when `navigator.userAgent` matches a mobile device or the viewport is ≤640 px wide
- Override in Settings → Display: **Auto** (default) / **Desktop** / **Mobile**, persisted to `localStorage['noctalum.displayMode']`
- `?mode=mobile` / `?mode=desktop` URL flags force the respective mode for testing
- Topbar: compact (logo + brand + station pill + tabs + logout); back-pill, op-badge, feature-request, station-id and rig detail are hidden
- QSO entry form: single-column grid with 44 px-tall inputs (16 px font to prevent iOS focus zoom); only `data-qso-pinned` fields plus mode + band are shown by default, a "+ More fields" button reveals the rest, and the expansion auto-collapses after each log
- QSO history table: tighter padding, sticky first column when scrolling horizontally, full-width filter input
- Ops panel: hidden inline; replaced by a fixed bottom-bar nav (Status / Stash / Cluster / Chat / Objective) that opens the matching pane as a full-screen sheet. ESC closes the sheet; tapping the same nav button toggles. iOS safe-area-inset honoured.
- Bottom-sheet uses the existing pane elements (re-parented), so all WebSocket-driven content (chat, stash badge, cluster spots) keeps working without duplicate state

## v0.33 — 2026-05-22 — Ops-panel tabs wrap to a second row when narrow

- `.ops-tabs` is now `flex-wrap: wrap` and each `.ops-tab` is `flex: 0 0 auto; white-space: nowrap`
- When the right sidebar is too narrow to fit Status, Stash, Cluster, Chat and Objective in one row, the overflowing tabs flow to a second row instead of overlapping past the panel border

## v0.32 — 2026-05-22 — Chat tab framed (input pinned at bottom)

- Chat input and Send button stay pinned at the bottom of the panel
- Tab header stays at the top; only the message list scrolls
- Previously the whole right panel scrolled when many messages accumulated, pushing the input out of view

## v0.31 — 2026-05-22 — Stash tab for in-flight QSOs (auto-stash on TRX QSY)

- New "Stash" tab in the ops panel between Status and Cluster
- When a callsign has been entered and the selected TRX moves to a different frequency (≥ 100 Hz shift), the in-flight New QSO entry is automatically stashed: all field values are captured along with the *old* frequency, and the form is cleared (as if ESC had been pressed)
- Click a stashed entry to retune the TRX to the stashed frequency and refill the form with the captured values (including custom fields)
- If the New QSO form already has data when a stash is recalled, the current contents are auto-stashed first
- Stashes are scoped per user + contest, persisted server-side (new `qso_stashes` table), and synchronised across all of a user's browser tabs via WebSocket
- New per-contest setting "Auto-delete stashed pre-QSOs after (minutes)" — default 60, settable from the contest settings modal
- Manual edits to the frequency input do not trigger a stash; only TRX-reported changes do

## v0.30 — 2026-05-22 — Fix band dropdown and notes field case in New QSO form

- Band selector in New QSO now correctly shows "20 m", "70 cm" etc. (CSS specificity fix)
- Notes field no longer forced to uppercase (same fix)

## v0.29 — 2026-05-22 — SSB/USB/LSB treated as same mode for duplicate detection

- USB and LSB are now normalised to SSB when checking for duplicate QSOs
- Affects the duplicate badge above the callsign field and the band-pill colour coding

## v0.28 — 2026-05-22 — Harmonized band label capitalization

- Band unit is now displayed with a space and lowercase: "20 m", "70 cm", "2 m", etc. everywhere (dropdowns, band pills, QSO table, stats, rig display, operator list, cluster filter, conflict banners)
- Internal band identifiers (stored in DB, API) are unchanged

## v0.27 — 2026-05-22 — Back-to-overview pill, station pill opens contest settings

- Contest view topbar: new slim "← Back to overview" pill below the Noctalum logo navigates back to contest selection
- Clicking the station pill (center topbar) now opens the contest settings modal instead of navigating away
- Read-only users see all contest settings with greyed-out fields and no save button

## v0.26 — 2026-05-22 — "What's New" dialog on version update

- Track the last app version each user acknowledged; show a "What's New?" dialog listing missed changelog entries on login or page refresh
- German translations now consistently use informal "du" instead of formal "Sie"

## v0.25 — 2026-05-22 17:00 UTC — Fix chat history loading on contest entry

- Chat message history now loads reliably when entering a contest
- Root cause: the WebSocket was reused from a previous connection, so the server never sent the history replay for the new contest
- Fix: WebSocket is now force-reconnected each time `enterApp()` runs, causing the server to replay recent chat messages for the current contest

## v0.24 — 2026-05-22 16:00 UTC — Notes no-caps, configurable log columns

- Notes field no longer forced uppercase (CSS override for `#q-notes`)
- Contest edit modal: draggable log-column picker below the WYSIWYG editor
  - Toggle visibility (Visible/Hidden pill) for each QSO field + custom fields
  - Drag rows to reorder columns
  - Configuration saved in contest as `log_columns` JSON (backend DB column added)
  - QSO history table headers and cells rendered dynamically from this config

## v0.23 — 2026-05-22 15:30 UTC — QRZ settings moved to Global Settings

- QRZ.com credentials removed from Personal Settings
- QRZ fieldset added to Global Settings with username, password, and test-connection button
- One shared QRZ account is now used for all server-side callsign lookups

## v0.22 — 2026-05-22 15:00 UTC — Fix chat sounds, remove Settings tab

- Fixed crash: stale `updateChatSoundToggleBtn` call was throwing a ReferenceError, breaking `showContestScreen` and silently disabling chat sounds
- Settings tab removed from the contest view topbar

## v0.21 — 2026-05-22 14:30 UTC — Chat sound mute consolidated into Personal Settings

- Chat sound mute button removed from the contest picker start page
- Replaced by a toggleable pill (with icon) in Personal Settings, left-aligned inside the card

## v0.20 — 2026-05-22 14:00 UTC — Auto-band from frequency, topbar cleanup

- Typing a frequency in the QSO form now automatically selects the matching band
- Contest settings gear button removed from topbar
- "My Settings" renamed to "Personal Settings" in the contest picker menu

## v0.19 — 2026-05-22 13:15 UTC — Download Helper AppImage pill below button

- AppImage pill is now displayed below the download button, inside the recommended box

## v0.18 — 2026-05-22 13:00 UTC — Download Helper recommended box

- AppImage label moved out of the button text into a separate pill sitting next to the button
- Recommended downloads (AppImage on Linux) wrapped in a light blue box enclosing both the button and the pill
- "Recommended" label shown above the box

## v0.17 — 2026-05-22 12:30 UTC — Download Helper polished

- Linux OS icon replaced with the official Tux from Simple Icons
- All download buttons now have exactly the same fixed width
- AppImage downloads show "Recommended" text above the button with an accent-colored border rim

## v0.16 — 2026-05-22 12:00 UTC — Download Helper refined

- OS picker buttons now display official brand logos (Windows 4-color flag, Apple silhouette, Linux penguin) instead of emoji
- Linux AppImage downloads are labeled as "AppImage" and carry a "Recommended" badge
- GUI helper description updated to mention that rigctld is bundled — no separate installation required

## v0.15 — 2026-05-22 11:00 UTC — Download Helper modal

- The sidebar download panel has been removed and replaced by a "Download Helper" nav button in the contest picker
- Clicking the button opens a two-step modal: first choose your OS (Windows, macOS, Linux — auto-detected), then see each application with icon, description, and download link(s)
- Three apps listed: Rig Control Helper GUI, Rig Control Helper CLI, and WSJT-X Bridge
- Unavailable apps for the selected platform are shown dimmed with a "Not available" note

## v0.14 — 2026-05-22 10:00 UTC — DOK Database management screen

- New "DOK Database" button in the contest picker nav (requires `dok.edit` permission)
- Wide-screen table showing all callsign ↔ DOK associations with search/filter
- Add, delete entries manually; import and export as CSV
- Auto-commit logic revised: a callsign's DOK is only stored on first encounter; if a cache entry already exists, logging a different DOK will not overwrite it

## v0.13 — 2026-05-21 16:30 UTC — Band-conflict warning revised

- Replaced orange band-pill/operator-row highlights with a pulsing red stripe below the operator list
- Stripe reads "MULTIPLE STATIONS ON [BAND]" and fades in and out slowly
- One stripe per conflicted band; hidden when no conflicts exist

## v0.12 — 2026-05-21 16:20 UTC — Revert "View log" badge on finished contests

- Removed the "View log →" badge from finished contests in the contest picker
- Reverted read-only banner text to the original wording

## v0.11 — 2026-05-21 16:05 UTC — Version in title bar

- Current version number shown next to "Noctalum" in the title bar on all screens, in light orange

## v0.10 — 2026-05-21 16:00 UTC — Changelog dates

- Each changelog entry now shows its date and time (UTC)

## v0.9 — 2026-05-21 15:52 UTC — DOK callsign caching

- When a callsign is re-entered in the QSO form, the DOK field auto-fills from the last logged QSO with that callsign
- DOK mappings are persisted in a `callsign_cache` table and updated on every QSO save (new and edits)

## v0.8 — 2026-05-21 15:50 UTC — Multi-op band-busy warning

- Band pills highlight in orange when another operator in the same contest is already on that band
- A soft-lock confirmation dialog warns before logging a QSO on a busy band
- Operator list highlights conflicting operators sharing your selected band

## v0.7 — 2026-05-21 15:46 UTC — UTC time entry fix

- Manual QSO time entry field now uses a time-only (HH:MM:SS) input, pre-filled with current UTC time
- Eliminates the previous bug where local time was logged as UTC

## v0.6 — 2026-05-21 15:44 UTC — My Settings accessible from contest picker

- New "My Settings" button in the contest picker nav (accessible to all users without entering a contest)
- Shows personal settings: default band/mode, QRZ credentials, password change, and passkeys

## v0.5 — 2026-05-21 15:41 UTC — Delete contest button

- Contest owners and admins can now delete a contest directly from the contest edit modal
- Requires confirmation before deletion; returns to contest picker

## v0.4 — 2026-05-21 15:40 UTC — Browse finished contest UX

- Finished contests now show a "View log →" badge in the contest picker (card and list views)
- Read-only banner text improved: clearly states you can browse the QSO history

## v0.3 — 2026-05-21 15:38 UTC — Chat visible on iPad

- Fixed: chat tab (message list and input field) now displays correctly on iPad and other narrow viewports (~768px)

## v0.2 — 2026-05-21 15:37 UTC — Serial number padding

- Contest serial numbers can now be padded to 3 digits (001, 042) — enabled by default
- Toggle in contest create/edit settings
- Changelog screen added to contest picker nav (visible to all users)

## v0.1 — 2026-05-20 08:07 UTC — Initial Release

- Initial release of Noctalum ham radio contest logger
- Go + SQLite backend, vanilla JS frontend
- English and German localization
- Per-contest access control with authorized user lists
- Per-user language preference
