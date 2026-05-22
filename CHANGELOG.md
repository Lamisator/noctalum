# Noctalum Changelog

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
