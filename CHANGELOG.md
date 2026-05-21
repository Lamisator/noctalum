# Noctalum Changelog

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
