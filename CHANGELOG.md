# Noctalum Changelog

## v0.80 — 2026-07-30 — Multiple attachments per feature request, with real filenames end-to-end

- **A feature request can now carry many files, not just one.** Previous releases stored a single attachment per `feature_requests` row via four columns (`attachment_filename` / `_mime` / `_size` / `_original_name`); attaching a second screenshot required creating a second feature request. Now the submit modal's file input is `<input type="file" multiple>`, the admin/my-requests overview lists every attachment on its own line, and every image previews individually in the existing wide preview modal.
- **New `feature_request_attachments` table** with `(id, feature_request_id, filename, original_name, mime, size, created_at)` and an index on `feature_request_id`. FK uses `ON DELETE CASCADE` so removing the parent request cleans up the metadata rows automatically; on-disk files are still cleaned up explicitly at the server layer via a `ListFeatureRequestAttachments` → `DeleteFeatureRequest` sequence in `handleFeatureRequestByID`. The legacy single-attachment columns on `feature_requests` stay in the schema so a rollback to a v0.79 binary still boots, but no new writes ever land there. An idempotent one-time backfill migrates any legacy row into the new table (`WHERE NOT EXISTS` guard) and clears the legacy columns immediately after, so subsequent boots and user-driven deletes never resurrect the row.
- **Store layer split** (`internal/store/store.go`): `InsertFeatureRequest(from, text)` is now text-only; per-file metadata is recorded via a new `InsertFeatureRequestAttachment(frID, filename, originalName, mime, size)`. `GetFeatureRequestAttachment(frID, attachmentID)` enforces the parent-child linkage so guessing sequential attachment IDs can't cross to a request the caller can't see. `ListFeatureRequests` / `ListFeatureRequestsByUser` / `GetFeatureRequest` all hydrate the new `Attachments []FeatureRequestAttachment` slice in a single follow-up `IN (…)` query (`loadAttachmentsForRequests`) so the API response is still one round-trip regardless of attachment count. The opaque on-disk token in `FeatureRequestAttachment.Filename` is `json:"-"`, replacing the previous strip loops in `handleFeatureRequests` / `handleMyFeatureRequests`.
- **Submit path rewrite** (`submitFeatureRequestMultipart`): now iterates `r.MultipartForm.File["attachment"]`, extracting a `saveOneAttachment` helper for per-file validation + disk write. All-or-nothing semantics: if any file fails validation or any DB write fails partway through, previously-saved on-disk files are rolled back and the parent row is deleted. New caps: `featureRequestAttachmentMaxSize = 5 MB` per file (unchanged), `featureRequestBodyMaxSize = 30 MB` for the multipart body as a whole (roughly six max-size files + text + slack), `featureRequestMaxAttachments = 10` files per submission — enforced client- and server-side.
- **Route change:** `/api/feature-requests/{id}/attachment` (singular) → `/api/feature-requests/{id}/attachments/{aid}`. The router in `handleFeatureRequestByID` detects the `attachments/` prefix and parses the tail. `serveFeatureRequestAttachment(id, attachmentID)` now looks up the specific attachment; its Content-Disposition still uses the stored original name and stays `inline` (so the preview modal's `<img src=…>` renders), but the filename parameter drives browser save-as behaviour.
- **Guarantee original filenames end-to-end.** Follow-up fixes to what shipped in v0.79 so the submitter's filename is preserved on every code path — the multipart handler now falls back to a synthetic `attachment.<ext>` derived from the file's extension if `hdr.Filename` sanitizes to empty (so the DB row always has a meaningful label instead of relying on a client-side fallback), and the download endpoint sets `Content-Disposition: inline; filename="…"; filename*=UTF-8''…` using the stored original name so browser save-as dialogs and right-click "Save image as…" both pick it up — the two paths that don't get the `<a download="…">` attribute from the frontend. Refactor: extracted `contentDispositionWith(kind, name)` as a shared helper; `attachmentDisposition(name)` now delegates to it with `kind="attachment"`, so all existing ADIF/Cabrillo/CSV/EDI/PDF exports keep their exact prior header format.
- **File-type badge on every attachment.** New `featureRequestAttachmentType(mime)` helper on the client returns `{ label, ext }` for the four accepted types (PNG/JPG/PDF/TXT) plus a subtype-uppercased fallback for anything else. The label ships next to the size in the attachment cell (`"screenshot.png (PNG · 12 kB)"`) and in the preview modal title. Legacy rows uploaded before v0.79 (which have no original name stored) fall back to a synthetic `attachment.<ext>` label derived from the mime type rather than a generic anonymous "Download" — same fallback the server now materializes in the DB for new uploads.
- **Frontend rendering** (`internal/server/web/app.js`): `featureRequestAttachmentCell(fr)` now maps over `fr.attachments`, rendering one line per attachment via a new `renderFeatureRequestAttachmentRow(fr, att)` helper — same click-to-preview + ↓ download UI as before, but per-attachment, wrapped in a small vertical flex column inside the `<td>`. The image-preview click handler carries both `data-fr-id` and `data-att-id` and hands the specific attachment to `openFeatureRequestImagePreview(fr, att)`. Download URLs everywhere use the new `/attachments/{aid}` route.
- **i18n updates** (`internal/server/web/i18n.js`): `featureRequests.attachmentLabel` now reads "Attachments (optional, multiple allowed)" / "Anhänge (optional, mehrere möglich)"; `attachmentHint` mentions the 5 MB per-file + 10-files-per-request caps in both EN and DE; new `attachmentTooMany` key for the client-side count-cap error message.
- **Tests** (`internal/store/store_pg_test.go`): the existing round-trip test now inserts a text-only request plus a request with two attachments (PDF + PNG) and asserts they come back in insert order with correct filename, mime, size, and original name on each.
- `programVersion` bumped from `0.79` to `0.80`.

## v0.79 — 2026-07-30 — Feature requests accept image attachments and show real filenames with in-app preview

- **Feature-request attachments now accept JPG/PNG in addition to PDF/TXT.** Users wanting to attach a screenshot to illustrate a bug or UI issue previously had to describe it in prose or drop the image somewhere else and paste a link; the `/api/feature-requests` upload path only whitelisted `.pdf` and `.txt`. `internal/server/server.go`: `allowedFeatureRequestAttachmentExts` picks up `.jpg`/`.jpeg` → `image/jpeg` and `.png` → `image/png`; the map drives both the file-type gate at upload time and the `Content-Type` on the download stream, so images stream with the correct MIME and the existing `Content-Disposition: inline` header lets browsers render them in a new tab. Error message and doc comments on `SetFeatureRequestAttachmentsDir`, `submitFeatureRequest`, and `serveFeatureRequestAttachment` updated to list the new formats.
- **Frontend accepts the new formats end-to-end.** `internal/server/web/app.js`: the `<input type="file" accept="…">` list in `featureRequestSubmitModal` now includes `.jpg,.jpeg,.png` plus the corresponding MIME types so the browser's file picker filters correctly, and the pre-upload extension check gates the same set client-side before POSTing. `internal/server/web/i18n.js`: `featureRequests.attachmentHint` and `attachmentBadType` updated in both EN and DE to list PDF/TXT/JPG/PNG. The 5 MB size cap, opaque-token filename scheme, per-request storage, and admin-or-submitter download ACL all apply to image attachments unchanged.
- **Attachments are now labelled with the submitter's original filename.** Until this release, the attachment column just said "Download (12 kB)" — no indication what the file was actually called. `internal/store/store.go`: new `attachment_original_name` column added via the existing idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migration list, threaded through the `FeatureRequest` struct, `InsertFeatureRequest`, `scanFeatureRequest`, and `featureRequestSelectCols`. `internal/server/server.go`: `submitFeatureRequestMultipart` runs `hdr.Filename` through a new `sanitizeAttachmentOriginalName` helper (`filepath.Base` + strip control chars + trim + cap at 255 runes) before storing — the value is only ever rendered as a label so it doesn't need to be a valid path, but it does need to be readable and bounded to keep hostile clients from bloating the row. The list endpoints already strip `AttachmentFilename` (the opaque on-disk token) but leave `AttachmentOriginalName` intact so it flows to the client.
- **Images preview in-app instead of forcing a new-tab jump.** `internal/server/web/app.js`: `featureRequestAttachmentCell` now shows `fr.attachment_original_name` (falling back to "Download" for legacy rows) with a small parenthetical size. For `image/*` MIME types the filename becomes an in-app preview trigger — clicking opens a wide modal with the image (`max-height: 70vh`) and an `.as-button`-styled Download button. A ↓ affordance next to the filename downloads directly, using the `download` attribute with the original filename so the saved file matches what was uploaded. Modifier-clicks (Ctrl/Cmd/Shift/middle) on the preview link fall through to the browser's normal open-in-new-tab behaviour. Non-image attachments (PDF/TXT) keep the "open inline in a new tab" behaviour to avoid forcing a save-as dialog on people who just want to read a PDF in the browser. The preview click handler is a single `document`-level delegation so both the admin (`fr-table`) and my/public (`my-fr-table`) views wire up automatically without touching either render function. `featureRequests.attachmentPreview` added to EN ("Preview") and DE ("Vorschau", `du` form per project convention).
- **Backwards compatibility.** Existing `feature_requests` rows have an empty `attachment_original_name` (default from the migration), so the label falls back to "Download" for pre-0.79 uploads — same UX as before this release. New submissions get the real filename. `internal/store/store_pg_test.go`: the two existing insert call sites are updated to the new 6-arg signature and the round-trip assertion checks that the new field survives insert → get.
- `programVersion` bumped from `0.78` to `0.79`.

## v0.78 — 2026-07-28 — Main menu (contest selection) is now smartphone-friendly

- **Contest selection screen matches the in-contest mobile treatment.** Until this release the contest-selection screen kept its three-column desktop layout on phones: a vertical 148 px nav pill on the left (My Requests, Changelog, Download Helper, DOK Database, Users, Groups, Audit Log, Feature Requests, Callsign requests, Backups, Personal Settings, Global Settings — a lot of vertical real estate), a min-width:400 px card in the middle that caused horizontal overflow on narrower phones, and a 240 px "Online Now" panel on the right. On a 375 px iPhone screen the layout wrapped awkwardly and every control had a desktop-sized tap target.
- **Layout stacks vertically on mobile-mode with explicit ordering.** `body.mobile-mode .contest-screen-layout { flex-direction: column }`; the three children get `order: 1/2/3` so nav pill → main card → online panel regardless of source order. The desktop `#contest-screen .login-card { min-width: 400px }` is dropped in mobile-mode so the card fits any viewport, and its padding shrinks from `20px 20px 12px` to `8px 8px 12px` at the body level and `14px 12px` on the card itself.
- **Nav pill becomes a 2-column grid of 44 px tap targets.** `body.mobile-mode .contest-nav-pill` overrides the vertical flex list with `display: grid; grid-template-columns: 1fr 1fr; gap: 4px`. Each `.nav-pill-btn` grows to `min-height: 44px`, font 13 px, icon 15 px. The `.nav-divider` and the `.nav-pill-btn-download` (Download Helper) get `grid-column: 1 / -1` so the divider still spans and the primary download action keeps its full-width prominence (bumped to 48 px min-height).
- **Online panel tucks to the bottom, full-width and compact.** `body.mobile-mode .contest-screen-side { order: 3; width: 100% }`; `.online-panel` padding reduced to `12px 14px`.
- **Public / private contest columns stack vertically** with the private column swapping its `border-left` for `border-top` since it's now underneath rather than beside the public column.
- **Toolbar controls grow to 34 px tap targets.** `.cpill` and `.cvbtn` (filter pills like All / Active / Closed and the Cards / List view toggle) get `padding: 7px 12px; min-height: 34px` in mobile-mode.
- **Contest list view collapses to three columns on mobile.** The desktop 6-column grid `1fr 110px 76px 92px 100px 36px` becomes `1fr 80px 64px` (name / call / status). Date, last-activity, and actions columns are hidden — users tap the row itself to enter a contest, so the actions column is not needed on mobile. `.cl-name` gets `white-space: normal` so long contest names wrap instead of ellipsing.
- **Contest create/import buttons stack vertically** at full width via `body.mobile-mode #contest-create-section { flex-direction: column }` + `button { width: 100% }`, matching how `.contest-list-actions` already stacks.
- **Contest topbar shrinks** to match the in-contest topbar treatment: `padding: 6px 10px; min-height: 48px`, logo down to 22×22 px.
- No HTML or JS changes — everything is driven by the existing `body.mobile-mode` class, which is auto-engaged by `detectMobile()` on phones or viewports narrower than 640 px, and manually toggleable from Settings. Desktop rendering is entirely unaffected.
- `programVersion` bumped from `0.77` to `0.78`.

## v0.77 — 2026-07-28 — Scrollable center column so the QSO history stays reachable on short viewports

- **Center column now scrolls as a whole when the entry mask + history don't fit.** On short viewports (laptops with narrow browser windows, split screens, docked panels), the New QSO mask used to dominate the middle column and squeeze the QSO history down to a couple of visible rows. First attempt at `526c763` let the mask itself shrink internally via `overflow-y: auto`, but that hid input fields behind an internal scrollbar — unacceptable, the operator needs every field of the New QSO mask visible at all times. Follow-up at `b1696b1` moves the scroll to the outer `.center-col` and drops the mid-panel resizer entirely: the entry mask always renders at its natural content height (all fields visible), and if that plus a comfortable history area exceeds the viewport the whole column scrolls so operators can reach the past-QSO list below.
- **Layout is now pure CSS.** `internal/server/web/style.css`: `.center-col` becomes `overflow-x: hidden; overflow-y: auto`; `.entry-panel` collapses to just `flex-shrink: 0` (drops the drag-managed `height: var(--entry-h)`, the 140 px min-height floor, and the internal `overflow-y`); `.history-panel` picks up `min-height: 240px` so scrolling always reveals a useful chunk of past QSOs. When both fit, the history panel still grows via `flex: 1` to fill the remaining vertical space. The now-redundant `.entry-panel { height: auto !important }` and `#resizer-mid { display: none }` overrides in the `@media (max-width: 880px)` and `body.mobile-mode` blocks are gone.
- **Mid-panel drag handle removed.** `internal/server/web/index.html` drops `<div id="resizer-mid">` and `internal/server/web/app.js` drops the `initPanelResizers()` mid-resizer handler plus the `panel-entry-h` localStorage restore/clamp logic — with the panel split gone, the drag handle had no remaining purpose. Horizontal left/right panel resizers (`#resizer-left`, `#resizer-right`) are untouched. Any stale `panel-entry-h` localStorage keys in existing browsers are left as harmless orphans.
- `programVersion` bumped from `0.76` to `0.77`.

## v0.76 — 2026-07-28 — Per-contest roles + groups, one-scan device login, Go/Fyne WSJT-X bridge, and a rebuilt deploy pipeline

### Security fixes

- **Per-contest QSO permissions replace the "any signed-in editor" model.** Until this release, anyone holding the global `qso.write` permission could create, edit, or delete QSOs in any contest they could see. Every mutation path (`handleCreateQSO`, `handleReserveNr`, `handleQSOByID` PUT/DELETE, and the `/api/contests/{id}/stashes` routes) now consults `effectiveContestRoleForSession()` in `internal/server/server.go` and requires at least `logger` on that specific contest. A `logger` may only touch rows they logged themselves — new `qsos.operator_user_id` column populated on insert; `editor` and `owner` may touch anything in the contest. Denials audit-log with the contest name so operators can spot probing attempts.
- **Existing "private" contests were being left visible to `qso.write` holders.** `migrateContests` added `contests.visibility` with `NOT NULL DEFAULT 'open'`, which fired before the follow-up backfill could look at the legacy `private` / `access_restricted` booleans; the backfill's `WHERE visibility NOT IN (…)` guard then never matched anything. Fixed with an unconditional correction that rewrites `visibility='open'` rows carrying `private OR access_restricted` to `visibility='private'` and re-syncs the legacy booleans back from `visibility`; idempotent on subsequent boots and verified with a live-Postgres round-trip.

### Per-contest roles & groups

- **Three-mode contest visibility: open / groups / private.** New `contests.visibility` column with `NormalizeVisibility()` helper that keeps the legacy `private` / `access_restricted` booleans in lockstep so audit, share tokens, and older UI paths keep working (`internal/store/store_pg.go`). Owners flip the mode from a new *Visibility* section in the contest edit modal via dedicated `PUT /api/contests/{id}/visibility` (separate from the main contest PUT so editing the QSO layout can't accidentally flip access rules).
- **Role vocabulary is now owner / editor / logger.** Legacy `user` participants migrate to `logger` transparently and the PUT participants endpoint still accepts `user` for older clients. `store.CountContestOwners` guards demote/remove of the last owner both server-side and in the UI. `ContestRoleAtLeast(have, want)` in `internal/server/auth.go` provides the hierarchy comparison used throughout.
- **New Groups admin tab** (nav pill gated by the new `groups.manage` permission, granted to every registered user by default). Create/rename/delete groups, add/remove members by username, toggle owner status. Group owners and `users.manage` holders see full controls; regular members get a read-only view. Every registered user can create groups they own — matches the "groups have owners; manageable only by creator + admins" model. `internal/store/groups.go`, `internal/server/web/{index.html,app.js}`, EN + DE i18n.
- **Inline group picker in the contest edit modal.** When visibility is set to `groups`, an inline checkbox list (parallel `GET /api/groups` + `GET /api/contests/{id}/groups`) grants access; `PUT /api/contests/{id}/groups` replaces the set atomically. Empty set is legal (leaves nobody with implicit access) and shows a hint pointing operators to the Groups tab.
- **Participant role dropdown** replaces the old promote/demote (↑/↓) buttons with a single owner/editor/logger `<select>` per active participant. Server rejects invalid values and last-owner strips; the row reloads against fresh state so the UI can never get stuck on a rejected choice.
- **Frontend gating helpers** in `app.js`: `contestRoleAtLeast(want)`, `canLogQSOs()`, `canEditQSO(q)` (compares `q.operator_user_id` to `me.user_id` for loggers), `canManageThisContest()`. `renderQsos()` hides the delete "✕" on rows the caller can't touch; the delete click handler re-checks before firing. Both the contest select response and the `contest_updated` WebSocket event now carry `contest_visibility` and `contest_my_role`, cached on `me` so the helpers resolve without re-fetching.
- **Audit vocabulary extended** with `group.create/update/delete`, `group.member_{add,remove,role_change}`, `contest.visibility_change`, `contest.group_access_change`; the audit filter dropdown picks them up automatically via `AllAuditActions`.

### Login with another device (QR-code pairing)

- **New sign-in path for browsers without saved credentials.** The login screen grows a *Login with other device* button underneath the passkey button. Clicking it opens a modal that `POST`s `/api/login-request/create`, encodes the returned ID as `origin/#approve=<id>` in a QR code (rendered by the vendored `qrcode-generator@1.4.4` at `internal/server/web/qrcode.min.js`, MIT-licensed, 20 KB), and long-polls `/api/login-request/status` (~25 s per HTTP call) for approval.
- **Approver flow works on any already-signed-in device.** Scanning the QR opens the app URL with `#approve=<id>`; `maybeShowApproverPrompt()` fetches the request metadata (IP, User-Agent, age) via `GET /api/login-request/{id}` and opens an Approve / Deny modal. A `summarizeUA()` parser renders "Firefox 128 on Windows 10/11" so the approver can spot a suspicious request. `POST /api/login-request/{id}/{approve,deny}` is CSRF-protected and uses `DecideLoginRequest`'s CAS so a race between two open tabs can only be resolved once.
- **Store layer** (`internal/store/login_requests.go`): new `login_requests` table (24-byte random hex id = bearer credential, requester_ip, requester_ua truncated to 512 B, status pending/approved/denied/consumed, 2-minute TTL). `ConsumeLoginRequest` runs `SELECT FOR UPDATE` inside a transaction so only the first poll after approval gets the cookie; `DeleteExpiredLoginRequests` wired into the existing hourly session-cleanup ticker.
- **Approver prompt on first page load fixed** (`f05ce0f`). The modal never appeared when the QR was scanned by a phone that was already logged in because the fast-path (existing session on page load) inlined the login follow-up instead of calling `bootstrap()`, so `maybeShowApproverPrompt()` was skipped. Fixed; also wires a `hashchange` listener so mobile QR scanners that only update the URL fragment in an existing tab surface the prompt too.

### WSJT-X bridge — Go/Fyne single-file rewrite

- **Retired the Qt/C++ bridge (~2000 LOC) in favour of a Go/Fyne rewrite** in `cmd/wsjtx-gui/`. Motivation: Qt loads its OpenSSL backend as a runtime plugin (`plugins/tls/qopensslbackend.dll`) that our bundler never packed, so the Qt Windows build failed with "TLS initialization failed" the moment it tried to POST a QSO. Fixing that would have meant shipping libssl/libcrypto + the TLS plugin + the Qt platform plugin on every user's disk. Go's `crypto/tls` is always available, Fyne pulls its own font and renders via OpenGL, so the whole app ships as a single 24 MB static binary per OS (Linux amd64/arm64, Windows amd64, macOS native). Feature parity with the retired Qt build: token + password auth, credentials on disk (per-user 0600), tone-coloured activity log, forget-credentials button, live QSO count with pending-queue indicator.
- **Persistent QSO outbox — bridges survive server outages.** Both bridges (CLI in `cmd/wsjtx`, GUI in `cmd/wsjtx-gui`) now buffer every incoming WSJT-X QSO through a JSON-backed outbox at the same per-user config path as credentials (atomic writes: temp file + rename; corrupt file renamed with `.corrupt-<ts>` suffix on next boot). A background retry loop drains with exponential backoff (5 s → 10 s → 20 s → 40 s → 5 min cap; resets on any successful wave or new item). Error classification: 201 → remove, 409 duplicate → drop with "duplicate" surfaced, 400/422 → drop with the server's error message (bad callsign, wrong station-call, invalid mode), transport / 401 / 403 / 5xx → retry. Auth is not persisted in the outbox — headers are attached at send time from the current session, so re-login or pasting a fresh token transparently resumes a stalled queue. `internal/wsjtx/{outbox.go,outbox_test.go}` shared by both bridges.
- **One-click bridge token replaces the username/password + contest picker.** New `noc1.` + base64url of `{"s":<server>,"t":<helper_token>,"c":<contest_id>,"sc":<station_call>}` blob generated client-side by the web UI (no server round-trip needed). Every contest card and list row grows a "📡" pill next to Share (gated on `qso.write` + status open) that opens a modal with the token and a Copy button. Same button also lives in the in-contest Status sidebar under "Available rigs" so operators find it right where they hook up a rig. Paste the token into the bridge and it starts logging immediately; the token confers exactly the same access as the operator's helper token would (per-contest role checks still run server-side).
- **New `POST /api/wsjtx/qsos` endpoint** in `internal/server/server.go` authenticated by an `X-Helper-Token` header + `contest_id` in the JSON body. Mirrors `handleCreateQSO` end-to-end: `qso.write` global check, per-contest `ContestRoleLogger` check with auto-join-on-first-activity for open/groups contests, duplicate detection with `?force=1` override, atomic NR allocation via the same `s.nrMu` / `s.nrNext` map so browsers and bridges cannot collide on serial numbers, DOK cache warm-up, audit entry marked `via: wsjtx-bridge`, hub broadcast.
- **MyCall station-callsign filter** (`3adf2ac`). The bridge now reads WSJT-X's `LOG_QSO` MyCall field and drops any QSO logged under a station callsign that doesn't match the contest's (both client-side in the bridge and server-side on `/api/wsjtx/qsos`, with base-callsign matching so `DM2LAP` still matches `DM2LAP/P`). Prevents a leftover WSJT-X config from silently polluting the log; server rejects with HTTP 422 and audits at Warn level naming both callsigns. Older bridges without `my_call` in the payload keep working — the client-side filter alone protects them via the token's `sc` field.

### Downloads

- **Windows and macOS cards for the wsjtx-gui and helper-gui-cpp downloads** now render on all three OS pickers (`linuxOnly:true` gate dropped). Missing per-platform artefacts show as "Not available for this platform" within the card rather than the card vanishing entirely — much clearer signal to the operator than an empty picker was. The filename regex was widened to also strip a trailing `.zip` (macOS bundle) alongside `.AppImage` and `.exe`. CLI cards (wsjtx-cpp, helper-cpp) keep `linuxOnly:true` since they're headless-server tools.

### Deploy pipeline (operator-facing)

- **PASS/FAIL summary table at the end of every deploy.** Every phase (build, remote-dir prep, .env bootstrap, compose upload, server-binary upload, downloads upload, systemd restore hook, graceful-shutdown trigger, compose swap, Telegram) records itself via a `record_step STATUS GROUP NAME` helper. A single `print_summary` function wired to the EXIT trap prints a colour-coded table (ANSI SGR 42;97;1 green / 41;97;1 red / 100;97;1 grey) so no failure can silently disappear into the middle of the ~600-line log. Chained with the Phase-3 recovery trap so a mid-downtime abort still both attempts to bring the stack up AND prints the table.
- **Per-artifact build report.** `build.sh` now emits `dist/.build-report.tsv` (`STATUS<TAB>CATEGORY<TAB>DETAIL`) that `deploy.sh` folds into the summary — one line per expected artefact: server / helper / wsjtx / notifier from the `*_targets` arrays (present = PASS, absent = FAIL); GUI variants forwarded from `gui_built` / `gui_skipped` split by `wsjtx-gui/` prefix; C++ variants likewise. Motivation: `wsjtx-gui/windows/amd64` had been silently failing for weeks because a stale `:latest` Docker image was still using Go 1.22 while go.mod required 1.25; a repeat is now impossible to miss.
- **Timestamped `deploy.log`.** Everything the script prints (build output, ssh/scp progress, summary table) is now tee'd through an awk timestamping filter (`awk '{ print strftime("%Y-%m-%dT%H:%M:%S"), $0; fflush() }'`) and appended to `deploy.log` in the repo root. Each line is prefixed with an ISO-8601 timestamp so post-mortems can grep for a specific minute instead of relying on the operator's scrollback. A session banner (row of `=`, `date -Iseconds`, argv) is written unstamped before the filter engages so distinct runs are easy to eyeball. Path added to `.gitignore`. The interactive "Select environment" prompt is written straight to `/dev/tty` so it doesn't sit invisibly in awk's line buffer.
- **Live bottom-row progress bar.** A DECSTBM scrolling-region trick (`\033[1;LINES-1;r`) reserves the terminal's last row for a live bar; log output above scrolls normally without ever overwriting it. Bar tracks 8 fixed phases and renders as `[███░░░░░░░░░]  25% (2/8) preflight (dirs, .env)` — green background fills as progress advances, grey shows what's left. Bar updates go to `/dev/tty` so they bypass the awk/tee log pipe. Non-TTY runs (CI, redirected) and terminals shorter than 8 rows transparently no-op.
- **Docker cache tags now versioned by `$GO_IMAGE`.** All derived images (`noctalum-gui-linux-amd64:appimage-go1.25-bookworm`, `noctalum-gui-windows-amd64:go1.25-bookworm`, `noctalum-gui-fyne-linux-{amd64,arm64}:go1.25-bookworm`, etc.) now stamp the Go version into their tag so a Go bump misses the cache and forces a fresh image build. Old `:latest` tags become orphans that `docker image prune` can reap. Fixed the root cause of the weeks-long silent Windows-build failure. Dockerfiles also switched from `<<'DOCKERFILE'` to `<<DOCKERFILE` + `FROM $GO_IMAGE`.
- **arm64 pre-flight.** `can_emulate_arm64()` probes `/proc/sys/fs/binfmt_misc/qemu-aarch64` before either arm64 GUI build starts; without emulation the target is soft-skipped (SKIP badge) with a one-time hint (`docker run --rm --privileged multiarch/qemu-user-static --reset -p yes`) rather than attempted-and-failed. New `gui_soft_skipped` array separates "environment can't attempt this target" (SKIP) from "build was tried and failed" (FAIL).
- **`--native` mode with Docker fallback for the Windows wsjtx-gui .exe.** `--native` is now treated as "prefer host tools" rather than "forbid containers": on linux/amd64 the wsjtx-gui Windows cross-compile tries host `x86_64-w64-mingw32-gcc` first, and if it's missing, silently swaps to the Docker mingw image (docker or podman, whichever is on `$PATH`) just for the Windows step. The Linux native build stays fully native.
- **`deploy.sh` purges `<app>/downloads/` before uploading.** Retired filename shapes (e.g. old `.zip` replaced by an `.exe`) can no longer linger and shadow the fresh files. Purge is targeted to the `noctalum-{helper,wsjtx}-*` namespace so ad-hoc uploads / README / icons are left alone. Runs only when we have new files to upload, so a `--no-helpers` deploy or a broken build can't accidentally wipe the download directory.
- **False-positive FAIL fix.** `build_helper_appimage()` packages the plain `noctalum-helper-linux-<arch>` binary into an AppImage and then `rm -f`s it; the build report was flagging those as `FAIL   helper   linux/{amd64,arm64}`. Skip the linux targets in the plain-binary check — the `helper-appimage linux/<arch>` entry covers them.
- **UTF-8 divider fix.** The horizontal `─` divider around the summary was constructed as `printf '%*s' 72 '' | tr ' ' '─'`. GNU `tr` operates byte-by-byte and doesn't understand multi-byte sets — it wrote only the first byte (0xE2) of the 3-byte UTF-8 for `─`, corrupting the whole line to a row of replacement characters. Switched to `printf '─%.0s' $(seq 1 72)`.

### C++ helper cross-compile (opt-in)

- **osxcross-based macOS bundle** for the C++ helper family. New `noctalum-cpp-macos` Docker image (debian:bookworm + `tpoechtrager/osxcross` built from source + Qt 6.7.3 cross-compiled for `macx-clang x86_64`). Requires an operator-supplied `MacOSX*.sdk.tar.xz` dropped into `cpp/third_party/osxcross-sdk/` (Apple's SDK licence forbids redistribution — see the README there for how to package one from a Mac). Produces an unsigned `.app` bundled as `.zip` (loose `.app` trees delivered over HTTP lose the executable bit). Off by default — `deploy.sh --cpp-macos` enables it. `--cpp-no-macos` is accepted as a no-op for muscle-memory.
- **Windows C++ cross-compile went through a saga** (MXE → Fedora mingw64 → dropped `helper-gui` because Fedora doesn't ship the WebSockets/SerialPort mingw64 packages) and was ultimately made moot by the Go/Fyne rewrite of `wsjtx-gui`. The Fedora mingw64 image survives for future use.
- **`cpp/helper-gui/`** `CMakeLists.txt` now marks the executable `WIN32` (no stray console window) and `MACOSX_BUNDLE` (Finder-friendly `.app` tree); `default_rigctld_bin()` switches to `QDir::listSeparator()` + `Q_OS_WIN`-conditional `rigctld.exe` so the Windows helper actually finds Hamlib's installer binary on `$PATH`.
- **`deploy.sh --cpp-no-windows` / `--cpp-no-macos` / `--cpp-macos`** flags forwarded verbatim to `build.sh` so operators without every toolchain can still deploy a subset without dropping into `build.sh --cpp-only` gymnastics.

### Housekeeping

- Bumped `programVersion` from `0.75` to `0.76`.

## v0.75 — 2026-07-27 — Graphical WSJT-X bridge with credential caching, plus a hi-DPI map-export fix

- **New cross-platform C++/Qt6 GUI for the WSJT-X bridge lives under `cpp/wsjtx-gui/`.** Depends only on Qt6 Widgets + Network — no libcurl, no third-party JSON, no WebSockets or SerialPort modules — so the resulting binary is small and behaviourally identical on Linux, macOS, and Windows. `main.cpp` forces the Fusion style so the QSS rules render consistently across platforms; QApplication metadata sets the Dock/taskbar name. `MainWindow` (`mainwindow.cpp`) builds the UI programmatically in three cards (Connection → Contest → Status → Activity), pulls the dark palette from `internal/server/web/style.css` (`--bg #121417`, `--accent #4fc3f7`, `--success #66bb6a`, etc.) via a single global stylesheet applied through `qApp->setStyleSheet`, and drives a small stage machine (`LoggedOut → LoggedIn → Selecting → Listening`) that enables/disables inputs and buttons so operators can't misfire actions. Status pill and progress dots repolish on state change (`unpolish`/`polish`) so the QSS selectors reapply immediately.
- **Session layer (`session.cpp`)** owns a single `QNetworkAccessManager` with an in-memory `QNetworkCookieJar`; `POST /api/login` extracts the server's `csrf_token` and every subsequent mutating request carries it as the `X-CSRF-Token` header. UDP `LOG_QSO` packets are handled by `QUdpSocket` with `ShareAddress | ReuseAddressHint`; a `224.0.0.0/4` multicast target triggers `joinMulticastGroup` after bind (matching the Go/CLI-C++ bridges). Each valid QSO fires an async `POST /api/qsos` (with `?force=1` when the "Log duplicates" checkbox is set); HTTP 409 turns into a soft warning in the activity log, not a hard error.
- **WSJT-X protocol parser (`wsjtx_protocol.cpp`)** is a port of `cpp/wsjtx/main.cpp`'s big-endian reader (magic 0xADBCCBDA, message type 5, Julian-day → Unix timestamp conversion, `QDateTime` layout matching Qt's own on-wire representation). Fields beyond what the server consumes (operator/my call, grids, exchange fields, propagation mode) are skipped intentionally rather than parsed and thrown away.
- **Optional credential caching (`credentials.cpp`)** persists to a per-user JSON file: `$XDG_CONFIG_HOME/Noctalum/wsjtx-bridge.json` on Linux (via `QStandardPaths::GenericConfigLocation`), `~/Library/Application Support/Noctalum/wsjtx-bridge.json` on macOS (via `GenericDataLocation` — `GenericConfigLocation` on macOS is `~/Library/Preferences`, reserved for plists), and `%APPDATA%/Noctalum/wsjtx-bridge.json` on Windows. POSIX writes get `chmod 0700` on the directory and `0600` on the file. The password is stripped from disk when `rememberPass` is false so a stale value can't leak across sessions, and a "Forget saved credentials" button in the UI wipes the file entirely.
- **`build.sh` grows a WSJT-X-GUI AppImage target.** To avoid duplicating the AppImage-packaging plumbing, `package_gui_appimage` now takes `(project, binary, desktop_name, out)` as parameters instead of hard-coding `helper-gui`; the existing `helper-gui-cpp` call site was updated in place and the new `wsjtx-gui` block follows the same pattern. The pkg-config availability check asks only for `Qt6Core/Widgets/Network` (`qt6-base-dev` is enough — no WebSockets/SerialPort needed), and skips gracefully with an "install qt6-base-dev" hint. Output filename is `noctalum-wsjtx-gui-linux-<arch>.AppImage`.
- **Downloads modal exposes the new GUI as its own card.** `APP_DEFS` in `internal/server/web/app.js` gains a `wsjtx-gui` entry (icon 📡, `linuxOnly: true`) so it renders alongside the CLI WSJT-X card only on Linux. The filename regex was widened with a `wsjtx-gui` alternative placed *before* `wsjtx-cpp`/`wsjtx` so the longer name wins the match — otherwise the shorter `wsjtx` alternative would swallow "gui-linux-amd64" as the platform suffix and file the AppImage under the CLI card. Three new EN/DE i18n keys (`appWsjtxGuiName`, `appWsjtxGuiVariant`, `appWsjtxGuiDesc`); the German copy uses the informal "du" form per the project rule.
- **Hi-DPI phones now export the PDF map with propagation lines placed correctly.** `renderPdfMapCanvas()` in `internal/server/web/app.js` composited Leaflet's vector layer with `ctx.drawImage(vecCanvas, 0, 0)`; the two-argument form uses the source's intrinsic (backing-store) size, and on `devicePixelRatio ≥ 2` Leaflet's `L.canvas()` renderer sizes that backing store to `size.x * DPR × size.y * DPR` so vector strokes stay crisp. The result on smartphones was every propagation line pasted at 2× (or 3×) scale from the origin, walking the endpoints off the visible map — the subsequent clip rect then hid them entirely. Fix reads `getBoundingClientRect()` on the vector canvas (CSS pixels, the same coordinate space the tile-drawing loop above already uses) and passes explicit width/height to `drawImage` so the physical backing store is scaled back into logical space. PC users were unaffected because their `DPR = 1` meant physical and logical sizes coincided.
- `programVersion` bumped to `0.75`.

## v0.74 — 2026-07-26 — C++ helper alternatives, feature-request attachments, admin rename, and a real staging environment

- **Feature requests can now carry an optional PDF or plain-text attachment (5 MB max).** File bytes live under a new `feature_request_attachments` subdirectory of the data-dir with an opaque token name; the `feature_requests` row gains three columns (`attachment_filename`, `attachment_mime`, `attachment_size`) added via idempotent `ALTER TABLE ADD COLUMN IF NOT EXISTS` so existing deployments upgrade without a separate migration step. Submit modal grows a file picker; both admin and "My Feature Requests" tables show an Attachment column with a per-row `Download (n kB)` link. `GET /api/feature-requests/{id}/attachment` streams the file inline with the stored MIME type; access = anyone with `feature_requests.read` OR the submitter themselves. Public-mode row visibility does not grant a download right. DELETE cleans up the on-disk file. Six new EN/DE i18n keys (`colAttachment`, `attachmentLabel`, `attachmentHint`, `attachmentDownload`, `attachmentTooLarge`, `attachmentBadType`).
- **Native C++ ports of the three Linux helper binaries land as separate downloads alongside the existing Go builds.** `cpp/wsjtx/` is a 1:1 behavioural port of the WSJT-X UDP bridge (libcurl + unicast/multicast socket + NetworkMessage LOG_QSO parser with Julian → Unix conversion). `cpp/helper/` is the CLI/TUI helper (libwebsockets + ncursesw + rigctld TCP client with the `shutdown(WR)` half-close trick to force an immediate response flush); shares the on-disk profile store with the Go helper so operators can switch implementations without re-entering credentials. `cpp/helper-gui/` is a Qt6 Widgets rewrite of the Wails desktop GUI — same section-for-section layout, QThread-based session worker, QWebSocket + QProcess for the managed rigctld, JSON profile format binary-identical to the Go GUI. `build.sh` gains `--cpp-only` / `--no-cpp` flags and only requires Docker for Go targets; new `build_cpp_all()` runs cmake/ninja under `.build-cache/cpp-build/` and wraps CLI binaries with appimagetool + the Qt GUI with linuxdeploy-plugin-qt (both auto-downloaded on first use). Download modal in `app.js` recognises the new `-cpp-` filename shapes as first-class cards (Linux-only via a new `linuxOnly: true` flag) with six new EN/DE i18n keys per card.
- **Admins with `users.manage` can rename user accounts.** New `store.SetUsername(userID, username)` normalises (trim + lowercase) and maps Postgres unique-constraint violation to the existing `ErrUsernameTaken` sentinel. `PUT /api/users/{id}` accepts an optional `username` field (pointer so absent vs empty can be told apart); no-op renames are skipped, a taken name returns HTTP 409, and a successful rename emits a new `AuditUserUsernameChange = "user.username_change"` warn-level entry with `renamed from X to Y` in details. Sessions key off `user_id` so no re-login is needed; the existing `sessions.RefreshUser` call flushes the cached username so open tabs see the new name on next request. Edit-user modal grows a Username field pre-filled with the current value plus a muted hint (`users.usernameEditHint`, informal-du in DE) explaining the lowercase-and-unique rule.
- **New staging deploy target at `log-staging.dm2lap.com`** lives alongside prod on the same host with fully independent Postgres data dir, `.env`, container names (`noctalum-staging`, `noctalum-staging-postgres`), and Docker network. `docker-compose.staging.yml` mirrors prod but sets `NOCTALUM_ENV=staging`, uses the `-staging` suffix everywhere, and requests its own LE cert (prod only gets away with `tls=true` because the standalone offline container has the certresolver label on the same Host rule). `deploy.sh` now requires `-prod` or `-staging` (or prompts on TTY); the shutdown-trigger heredoc takes the target container name as a third arg so `docker inspect` looks at the right container; systemd restore hooks install only on prod (single host-wide path unit watching prod's data dir); Telegram announcements are skipped for staging.
- **Non-prod deployments render a caution-tape STAGING ribbon** so operators can't mistake the copy for prod. Iterated from a diagonal top-left corner ribbon to a full-width top bar (24 px, `position: fixed`, `body.env-ribbon-active { padding-top: 24px }` reserves layout space) that repeats the env name across the viewport with real space separators. Text-shadow yellow halo was replaced with a 2px `-webkit-text-stroke` white outline + `paint-order: stroke fill` so the label stays legible over both the yellow and black stripes. Wired via `NOCTALUM_ENV` env var → new `Server.SetEnv()` → `/api/ping` response → `app.js` populates the ribbon on IIFE entry; missing or `prod` value leaves the ribbon `[hidden]`. Prod is entirely unaffected; the mechanism uppercases whatever env name the server reports so a future `preview` env gets its own ribbon with zero frontend changes.
- **`deploy.sh -nohelpers` (and `build.sh --no-helpers`)** skips the helper/wsjtx/GUI rebuild + upload for server-only iterations — several minutes saved on staging cycles that only touch server code. Composes independently of `--skip-build`: `-nohelpers` builds server+notifier fresh and skips the helper upload block; `--skip-build` reuses whatever is in `dist/`.
- `programVersion` bumped to `0.74`.

## v0.73 — 2026-07-17 — Cluster band filter follows contest switch; Go builder image refreshed

- **Cluster band + mode dropdown now refreshes on contest switch.** The
  cluster view's band selection dropdown used to keep the previous
  contest's bands until `loadClusterSpots()` fired next (cluster-tab
  activation, 60-second auto-refresh, or manual refresh). If the
  operator opened the cluster tab straight after switching contests,
  the filter offered bands the new contest doesn't even use. Fix:
  `enterApp()` in `internal/server/web/app.js` now calls
  `updateClusterFilters()` directly alongside the other per-contest UI
  resets (`renderBandPills`, `renderObjective`, `renderCustomFields`),
  so the `<select>` is rebuilt from the fresh `me.contest_bands` the
  moment the switch lands. Preserved-selection edge case handled
  cleanly: if the previously-selected band isn't present in the new
  contest, reassigning `innerHTML` with no `selected` attribute makes
  the browser fall back to the first option ("All bands"), and
  `renderClusterSpots()` reads `.value` fresh from the DOM so the
  filter clears without any explicit reset.
- **Go builder image bumped to 1.25-bookworm.** The default
  `GO_IMAGE` in `build.sh` plus the three inline `FROM` lines in
  `build_gui_linux_amd64`, `build_gui_linux_arm64`, and
  `build_gui_windows_amd64` all moved from `golang:1.22-bookworm` to
  `golang:1.25-bookworm`; the `--image` usage example in the
  top-of-file comment moved from `golang:1.23` to `golang:1.26`. Native
  builds (which use whatever local Go toolchain is installed) are
  unaffected. Dockerised builds pick up the newer stdlib, compiler
  improvements, and security fixes shipped between 1.22 and 1.25.
- `programVersion` bumped to `0.73`

## v0.72 — 2026-07-17 — Contest scheduling + closed-contest browsing, branded 504 page

- **Contests can now carry an optional start and end date.** Two new
  date pickers in the create + edit contest modals let operators pin a
  contest to a calendar window. Both fields are optional and the UI
  spells out the semantics: leaving the end date blank makes it a
  single-day contest; leaving both blank preserves the pre-v0.72
  behaviour (contest stays open indefinitely, no auto-close). Setting
  End < Start is rejected on both client and server with the new
  localised `contestScreen.endBeforeStart` message.
- **Scheduled contests auto-close after the last day passes.** New
  `contestAutoCloseLoop` in `internal/server/server.go` runs on boot
  and then hourly; it calls the new
  `Store.AutoCloseExpiredContests(now)` which does a single Postgres
  `UPDATE contests SET status = 'finished' ... WHERE
  COALESCE(end_date, start_date) < today_utc RETURNING id`, covering
  both the single-day and range cases in one round-trip. Each closed
  contest is refreshed on every live session via
  `UpdateContestOnSessions` and broadcast as a `contest_updated` WS
  event so open UIs slide into read-only mode without a page reload.
- **Backend plumbing for contest dates.** New nullable `start_date` /
  `end_date` DATE columns on the `contests` table (added via
  `CREATE TABLE ... start_date DATE, end_date DATE` for fresh installs
  plus `ALTER TABLE contests ADD COLUMN IF NOT EXISTS` for upgrades so
  existing production instances pick them up on the next boot). The
  `Contest` struct gains `StartDate` / `EndDate` as `*time.Time` (JSON
  serialises to `null` when unset), a `normalizeDate` helper truncates
  to UTC midnight so date-only semantics survive pgx's TIMESTAMPTZ
  round-trip, and `CreateContest` / `UpdateContest` accept the two
  dates. POST/PUT `/api/contests` handlers accept ISO date strings
  (`YYYY-MM-DD`) via a new shared `parseOptionalDate` helper. All call
  sites (contests handler, share-import) updated; `DuplicateContest`
  intentionally starts the copy with no dates so operators pick a fresh
  schedule per instance. WS `contest_updated` payload now echoes both
  dates.
- **Closed-contest QSO rows now populate the mask again.** Clicking a
  past QSO row in a finished contest used to *try* to run the QRZ
  lookup for that station's callsign, but the fresh result was silently
  dropped: `triggerQRZLookup()`'s staleness guard compares the callsign
  it looked up against the current `#q-call.value`, and the read-only
  path never populated the QSO mask, so the input stayed empty and the
  guard rejected the response. The visible symptom for operators
  browsing a finished contest was a QSO row that did nothing on click —
  no photo, no bearing, no country flag update. The click handler now
  unifies the read-only and writable paths — both call
  `loadQsoIntoForm(q)` so `#q-call.value` matches the lookup — and in
  the closed-contest case it re-runs `applyContestReadonly()` as a
  belt-and-braces guard so every input plus the "Save Edit" button stay
  disabled. `loadQsoIntoForm()` now picks its panel title based on
  `contestIsOpen()`: an open contest still reads "Edit QSO" (write
  mode), a closed one reads the new "View QSO" so operators aren't
  teased with a Save button that will never fire. New EN/DE i18n key
  `qso.viewQSO` (informal "du" form on the German side).
- **Restore-from-UI modal actually accepts the type-to-confirm input
  now.** The v0.71 restore button was a no-op live in production:
  `openRestoreModal()` built its inner HTML with the input + actions at
  the top level of the modal card, forgetting the `<form>` wrapper that
  `showModal()` hangs its submit listener and post-render selectors on.
  Neither ever bound, so clicking the submit button did nothing AND
  the input's `input` event listener never attached — meaning the
  button stayed at its initial `disabled = true` state indefinitely,
  even after typing the filename correctly. Wrapped the modal contents
  in `<form>…</form>` (matching every other modal in the app) and left
  an inline comment explaining why the wrapper is load-bearing so a
  future rewrite doesn't strip it again.
- **Backup audit coverage completed.** Not every backup-related action
  was showing up in the audit log:
  * Scheduler-driven automatic daily takes ran in `RunScheduler`'s
    goroutine and only logged to stdout — nothing hit `audit_log`.
  * Retention-based prunes had the same problem: files vanished from
    `./backups/` with only a stdout line explaining why.
  * Changes to `BackupRetentionDays` went through the standard
    settings PUT (audited as `settings.change`) but the retention
    value was NOT in the detail line, so the audit entry didn't say
    what the new value was.

  Fixes: `internal/backup/backup.go` gains an
  `OnAudit(action, target, details, isError)` callback (nil-safe) that
  the scheduler's `tick()` calls on every auto take (success + failure)
  and every retention prune (success + failure). Directly-invoked
  `Manager.Take` / `Manager.Prune` intentionally do NOT emit through
  the callback — those live in HTTP handlers that already audit at
  their own layer. `SetBackupsDir()` wires the callback to
  `s.store.InsertAuditLog` with actor `"system"` and severity mapped
  from `isError`. New `AuditBackup{Take,Auto,Download,Delete,Prune,Restore}`
  constants replace the hardcoded strings in `backups.go` handlers,
  and `appendDetail()` in `settings.go` now reports
  `backup_retention_days`, `cluster_retention_days`, `chat_sound`,
  and `public_feature_requests` on `settings.change` entries (the
  backup-retention entry is permission-gated so we only report it when
  the caller had authority to change it). New test
  `TestSchedulerFiresOnAuditForAutoTakes` seeds a backdated backup,
  cancels the scheduler after one tick, and verifies exactly two audit
  events fired.
- **Deploy hardened: upload before shutdown + recovery trap +
  keep-alives.** A prior deploy hung mid-`scp` after `docker compose
  down` had already fired; prod was offline for ~10 minutes until an
  operator noticed and killed the stuck SFTP by hand. Three structural
  changes make that failure mode impossible:
  1. **Upload-first.** Every file that has to land on the server
     (compose file, server binary, systemd units, helper downloads)
     is uploaded while the old app is still serving. The
     shutdown/swap window only opens after every upload has succeeded.
     If any upload fails or hangs, prod is untouched.
  2. **Recovery trap.** A `trap ... EXIT` armed right before the
     shutdown-trigger step attempts `docker compose up -d` on ANY
     early exit (error, signal, hang timeout). A `deploy_succeeded=true`
     flag + `trap - EXIT` clears it on the happy path. Worst case
     after this: the trap starts whichever binary is currently on
     disk — either the new one (if the `mv` happened) or the old one
     (if it didn't). Either way prod is serving something.
  3. **SSH keep-alive.** `SSH_OPTS` now carries `ConnectTimeout=10`,
     `ServerAliveInterval=15`, and `ServerAliveCountMax=4` — a stalled
     connection dies within ~60 s of silence with an error the trap
     catches, instead of hanging until a human intervenes.

  The stop-swap-start sequence itself is now packed into one SSH
  heredoc (`docker compose down` → `mv .new` → `docker compose up -d`)
  so the "app down" window is ~one round-trip long and either fully
  commits or fully aborts (`set -euo pipefail` inside + trap outside).
  Pre-flight `rm -f *.new` cleans up any staged files left behind by
  a previous crashed deploy.
- **Branded 504 offline page at log.dm2lap.com.** When the Noctalum
  container is stopped (deploys, crashes, planned maintenance) users
  previously landed on Traefik's default 404 — generic, ugly, and gave
  no indication the service would be back. A standalone nginx:alpine
  container under `deploy/offline-page/` now also claims
  ``Host(`log.dm2lap.com`)`` via Traefik docker labels but at
  `priority=1`, in its own compose project outside the Noctalum stack
  so `./deploy.sh` never brings it down. The nginx config returns real
  HTTP 504 for every path via `return 504` + `error_page 504
  /index.html`. `docker-compose.prod.yml` also gained an explicit
  `traefik.http.routers.noctalum.priority=100` label on the noctalum
  service so the priority ordering is unambiguous (Traefik's default
  priority is rule length, which already beats 1, but hard-coding 100
  removes any dependency on that default).
- **Offline page: outage contact + looping "TV losing signal"
  sequence.** The 504 page picked up two visual iterations after the
  initial branded drop:
  * A "if the problem persists, contact DM2LAP at dm2lap@darc.de"
    line under both the EN and DE messages (as a `mailto:` link,
    styled with the sheet's `--accent` so it matches the "Noctalum"
    heading), so users who see the page for more than a moment know
    who to reach and don't assume the whole service is gone.
  * The static-then-locked-test-pattern became a continuous ~10 s
    reception cycle: static-only for 60% of the cycle (receiver
    hunting), a hard-cut flash-in of the SMPTE colour bars for 2%,
    16% of readable "Technical Difficulties / Please Stand By"
    chyron, then 12% of progressive distortion (translate + skew +
    scaleY + hue-rotate + contrast + blur across four accumulating
    keyframes) before static takes back over. The RAF noise loop lost
    its `stopAt` cut-off and now runs forever — the CSS opacity ramp
    handles visibility across the phases. `prefers-reduced-motion`
    users get the pattern hidden entirely (`display: none`) —
    WCAG 2.3.3 asks for suppression of any content that flashes at a
    rate a viewer can't control, and the flash-in fires every 10 s.
    The centred info card still carries the outage message on its own
    for that cohort.
- `programVersion` bumped to `0.72`.

## v0.71 — 2026-07-16 — Restore a database backup from the admin UI

- **New "Restore" button on every backup row.** Reverses the
  earlier download-only design: operators with the `backups.manage`
  permission can now trigger a restore from the UI instead of
  SSHing in. The button is danger-styled and behind a type-to-
  confirm modal — the submit button stays disabled until the
  operator types the target backup's exact filename (same
  discipline GitHub / AWS impose for destructive actions).
- **The app does NOT execute the restore itself** — dropping and
  reloading tables while the app holds live DB connections would
  be self-destructive. Instead, `POST /api/backups/<name>/restore`
  writes a JSON trigger file (atomically, via temp + rename) at
  `data/restore_trigger`, and a new host-side systemd path unit
  picks it up. New files under `deploy/systemd/`:
  * `noctalum-restore.path` — `PathModified` watch on the trigger
    file (not `PathExists`, which would re-fire every second
    while the file sits around).
  * `noctalum-restore.service` — oneshot unit that runs the shell
    script.
  * `noctalum-restore.sh` — parses the trigger JSON (jq if
    available, else python3, else regex fallback), refuses if the
    referenced backup file is missing or the filename contains
    path-traversal characters (defence in depth — the app already
    validates, but a compromised app shouldn't be able to
    psql-load arbitrary files), then `docker compose stop
    noctalum` → `zcat backups/<file> | docker exec -i
    noctalum-postgres psql -v ON_ERROR_STOP=1 ...` → `docker
    compose start noctalum`. An `EXIT` trap deletes the trigger
    file on every code path (success OR failure) so the path
    unit doesn't re-fire in a loop. If psql fails, the container
    is started back up anyway to avoid turning a bad restore
    into a full outage.
- **Belt-and-suspenders safety backup before the restore runs.**
  The endpoint calls `Manager.Take()` first and only writes the
  systemd trigger if that succeeds — so a botched restore always
  leaves a one-step rollback (`noctalum-<ts>-<hash>-manual.sql.gz`)
  in `./backups/`. If the safety take fails, the whole restore is
  aborted; the operator retries once the underlying issue is
  fixed. Refuses with `409 Conflict` if a restore is already in
  flight (another trigger file exists).
- **Restore triggers a browser-side overlay across every open
  session.** Before writing the trigger, the endpoint broadcasts
  a `restore_starting` WebSocket event to every connected browser.
  The frontend handler reuses the existing deploy-warning modal +
  polling machinery with a restore-specific title/body and a
  shorter 5-second countdown — systemd fires within a second or
  two of the trigger, so the container-down phase is basically
  immediate. From every user's POV the whole thing looks like a
  normal deploy: "restore in progress, please wait, reconnecting…"
  overlay for ~30 s, then the page comes back on the freshly
  restored database. `showDeployWarning(seconds, opts)` grew an
  optional `{title, body}` overrides parameter so the restore
  path can reuse the same countdown/polling without duplicating
  logic.
- **Audit-logged at error level.** Restore is the single most
  destructive action in the app — a cluster of `backup.restore`
  events in the audit log should stand out. The record carries
  the target filename plus the safety-backup filename for later
  forensics.
- **New EN/DE strings** (DE informal `du` per CLAUDE.md): the
  restore button label, the confirm modal (title + destructive
  warning + safety-backup note + type-to-confirm prompt + submit
  button), a mismatch error, a failure error, and the "restore
  starting" overlay title + body. The pre-existing "How do I
  restore?" collapsible now points at the systemd hook as the
  primary path, keeping the SSH recipe as a documented fallback
  for setups where the systemd unit isn't installed.
- **`deploy.sh` grew an "Installing systemd restore hook" step.**
  scp's the three systemd files to `/etc/systemd/system/` on
  every deploy, then `daemon-reload` + `enable --now
  noctalum-restore.path`. Both operations are idempotent —
  `daemon-reload` only re-reads files that actually changed,
  `enable --now` is a no-op on already-active units. Keeps the
  systemd hook version-locked to whatever release of the app
  owns the trigger-file contract.
- `programVersion` bumped to `0.71`.

## v0.70 — 2026-07-16 — Automatic daily database backups, deploy hardening

- **Automatic daily database backups with deduplication and
  configurable retention.** New `internal/backup/` package with a
  schema-agnostic native Go SQL dumper (Kahn's algorithm on
  `pg_constraint` for FK-safe INSERT ordering — avoids needing
  `SET session_replication_role = replica` which would require
  SUPERUSER) and a Manager that streams each dump through gzip +
  sha256 in one pass. Files are named
  `noctalum-<ts>-<12hex>-{auto|manual}.sql.gz`; if a Take() run
  produces the same 12-hex content hash as an existing file the
  temp is discarded — identical data doesn't produce duplicate
  files even if the scheduler triggers close together. An hourly
  scheduler goroutine takes a fresh backup when the newest is
  older than 24 h, then prunes anything past
  `Settings.BackupRetentionDays` (default 30, `0` = keep forever).
  Reads happen under a REPEATABLE READ read-only snapshot so live
  writers aren't blocked.
- **Admin UI: backup list + manual take + download + delete.** New
  "Backups" nav pill (perm-gated behind the new `backups.manage`
  permission — regular admins inherit it via the `*` wildcard,
  everyone else needs it explicitly). Screen lists every backup
  with date / kind / size / hash-prefix / download / delete
  buttons, plus a "Take backup now" primary action. Delete goes
  through the standard confirm modal and audit-logs at warn level.
  Restore is intentionally **not** offered as a button — a
  collapsible "How do I restore a backup?" section shows the SSH
  recipe (`docker compose stop noctalum && zcat *.sql.gz | docker
  exec -i noctalum-postgres psql ...`) instead. Keeping the "one
  click to wipe the DB and reload from snapshot" out of the UI
  removes a category of catastrophic misclicks. Full EN/DE i18n
  with the DE side in the informal `du` form.
- **Retention setting in Global Settings.** New "Database backups"
  fieldset (perm-gated on `backups.manage`) with a Retention (days)
  input. Value round-trips through `Settings.BackupRetentionDays`.
  The scheduler goroutine re-reads the setting on every tick so a
  change in the UI takes effect within an hour without a restart.
  Both `/api/settings` GET and PUT gate the field on
  `backups.manage` rather than `settings.write` so retention can
  be delegated separately from the rest of the global-settings
  surface.
- **New `/backups` bind mount** on the `noctalum` service in both
  compose files, `-backups-dir` flag on the server binary
  (default `/backups`, empty disables the feature).
  `Store.DB() *sql.DB` accessor added so the backup package can
  reach pg_catalog / information_schema without a second
  connection pool.
- **`fix(server)`: stale `shutdown_trigger` cleared at startup.**
  Symptom on the v0.69 cutover — the new container picked up the
  file the previous instance never finished processing, broadcast
  a phantom deploy_warning, and SIGTERM'd itself 30 s later
  (docker's `restart: unless-stopped` recovered it). Root cause
  lived in `deploy.sh` (see next bullet), but the app-side guard
  is the belt-and-suspenders half: `SetShutdownTriggerPath` now
  `os.Stat`+`os.Remove`s any pre-existing trigger file before
  starting the polling goroutine and logs the removal so operators
  can spot it. A file existing at startup is by definition stale.
- **`fix(deploy)`: shutdown detection uses `docker inspect`, not
  `curl`.** The old poll shelled out to
  `curl http://localhost:8675/api/me` over SSH, but the prod
  compose file never publishes 8675 to the host (Traefik fronts
  it) — the poll failed on the first attempt, the while loop
  exited as "server stopped," and `docker compose down` fired
  before the app had even started its countdown. Replaced with a
  `docker inspect --format='{{.State.StartedAt}}' noctalum` check:
  snapshot the timestamp before writing the trigger, poll every
  2 s inside a single SSH session, exit when the value changes
  (the app SIGTERM'd, docker restarted the container, which bumps
  `StartedAt`). Timeout at countdown+15 s so we don't hang if the
  restart never happens. The 30 s user warning now actually plays
  out end-to-end during deploys.
- `programVersion` bumped to `0.70`.

## v0.69 — 2026-07-16 — PostgreSQL storage backend, ADIF export refinements

- **Storage backend migrated from SQLite to PostgreSQL 16.** The
  `internal/store/` package was rewritten against `jackc/pgx/v5`
  (via the `pgx/v5/stdlib` shim), keeping the existing `*sql.DB`
  method signatures so no call site outside the package changed.
  Every DDL, placeholder, and dialect-specific construct was
  converted: `BIGSERIAL PRIMARY KEY` for auto-ids, `TIMESTAMPTZ`
  for timestamps (no more RFC3339 string round-trips on read/write),
  real `BOOLEAN` for what used to be `INTEGER 0/1`, `?` → `$N`
  placeholders across ~140 call sites, `INSERT OR REPLACE`/`IGNORE`
  → `ON CONFLICT DO UPDATE`/`DO NOTHING`, `PRAGMA table_info`
  removed (schema is now expressed entirely in the initial
  `CREATE TABLE` statements), and unique-violation detection via
  `pgconn.PgError` code `23505` instead of
  `strings.Contains(err.Error(), "UNIQUE")`. `store.Open()` now
  takes a DSN; `main.go` accepts `-db` or the `DATABASE_URL` env
  var plus a new `-data-dir` flag (default `/var/lib/noctalum`)
  that owns `sounds/`, `callsign_proofs/`, and the
  `shutdown_trigger` file — previously derived from the SQLite
  file's parent directory.
- **New `cmd/sqlite-to-pg` migration tool.** One-shot binary that
  reads a SQLite backup file and loads it into a fresh Postgres
  schema in a single transaction. Preserves IDs and advances every
  `BIGSERIAL` sequence past the loaded `MAX(id)` so subsequent
  app-side INSERTs don't collide. Handles three real prod-data
  quirks discovered against the live backup: 75 Latin-1-encoded
  DX-cluster comments (sanitised through `strings.ToValidUTF8` in
  an `m.exec()` wrapper), one legacy Unix-epoch timestamp in
  `feature_requests` (extended `parseTS` to accept 10-digit epoch
  seconds), and `cluster_spots.created_at` using SQLite's
  `datetime('now')` format instead of RFC3339. Dry-run mode reads
  and transforms every row without committing. Refuses to load
  into a non-empty schema unless `--force` is passed.
- **Postgres in docker-compose with bind-mounted pgdata.**
  `docker-compose.prod.yml` gained a `postgres:16` service on an
  internal `db` bridge network (not exposed to the host or
  Traefik), with a `pg_isready` healthcheck and
  `depends_on: condition: service_healthy` so the app doesn't
  race Postgres on cold boot. Data lives in `./pgdata`
  (bind-mounted per the "easy backups, not a docker volume"
  requirement). `docker-compose.yml` (dev) mirrors the layout but
  exposes Postgres on `127.0.0.1:5432` for local `psql`/DBeaver.
  `deploy.sh` grew a first-run `.env` bootstrap that generates a
  40-char random `POSTGRES_PASSWORD` via `openssl rand -base64`
  and never overwrites an existing `.env`; the retired
  `--transfer-db` flag now points operators at `cmd/sqlite-to-pg`.
  New `backup.sh` script runs `pg_dump` inside the container to
  `./backups/noctalum-YYYYMMDDTHHMMSSZ.sql.gz`, with a `--remote`
  mode for the production host. Raw `pgdata/` copies are
  deliberately not supported — Postgres writes continuously and a
  hot file copy can be inconsistent.
- **Runtime UTF-8 sanitisation at insert boundaries.** SQLite
  silently stored arbitrary bytes; Postgres rejects any non-UTF-8
  payload with SQLSTATE 22021 and drops the whole INSERT. A new
  `internal/store/utf8.go::cleanStr()` (fast-path for valid input,
  else `strings.ToValidUTF8` + NUL strip) is applied at four
  insertion paths where the input is provably external and
  byte-oriented: `SaveClusterSpot` (DX cluster comments — the
  confirmed regression, ~2 lost spots per 15 min from European
  Latin-1 spotters after the cutover), `InsertChatMessage`,
  `UpsertCallsignDOK`, and `InsertAuditLog`. User-authored fields
  from the JSON HTTP layer are already valid UTF-8 at decode
  time so they're left alone.
- **ADIF export tightened against the 3.1.5 spec** (follow-up to
  FR #67, dl8aa). `ADIF_VER` bumped `3.1.4` → `3.1.5` so the
  declared version matches the byte-length semantics we use for
  `NAME_INTL`/`NOTES_INTL` (the spec changed the length rule to
  bytes in 3.1.5). `GRIDSQUARE` (partner locator) is now
  uppercased to match `MY_GRIDSQUARE` and the LotW/eQSL/DXCC
  convention. A new `normaliseCRLF` helper rewrites any mix of
  LF/CR/CRLF to canonical CR/LF before `NOTES` is emitted (bare
  LF is non-conforming for `MultilineString`). Custom fields
  whose name matches a standard ADIF tag (`STATE`, `POTA_REF`,
  `TX_PWR`, …) are now emitted under that standard tag instead
  of getting wrapped in `APP_NOCTALUM_` — a new
  `adifStandardFields` set decides at export time, with the
  `APP_` prefix as the fallback for anything unknown.
- **Contest custom-fields editor suggests standard ADIF tags.**
  The "Field name" input in the contest-settings mask now
  advertises a curated `<datalist>` of ~45 tags contest / DX /
  SOTA / POTA operators reach for most often (`STATE`,
  `POTA_REF`, `TX_PWR`, `RIG`, `CHECK`, `PRECEDENCE`,
  `ARRL_SECT`, `MY_ANTENNA`, `IOTA`, `WWFF_REF`, …). Browsers
  surface it as a type-ahead dropdown but still accept free
  text, so contest-specific non-ADIF names keep working. A
  short EN/DE hint below the editor explains the trade-off:
  standard-named fields export as that tag verbatim; anything
  else exports as `APP_NOCTALUM_<name>`.
- `programVersion` bumped to `0.69`.

## v0.68 — 2026-07-15 — Callsign change requests, ADIF spec-conformant exports

- **New "Request callsign change" flow in Personal Settings.**
  Operators submit a new callsign together with a scan/photo of the
  licence upgrade (jpg/png/pdf, up to 5 MB); admins with the new
  `callsign_requests.review` permission get a top-nav "Callsign
  requests" screen listing every pending request with the proof link
  and inline Approve / Decline buttons. Approval updates the stored
  callsign and refreshes every live session for the user via
  `SessionStore.RefreshUser` so the topbar and outgoing chat call
  update without a re-login. One request in flight per user is
  enforced server-side; withdrawing marks the row rejected
  ("withdrawn by user") to preserve the audit trail. Uploads land in
  `<db-dir>/callsign_proofs/` with random opaque filenames written
  `O_EXCL 0600`, and the proof file is deleted the moment a decision
  is recorded — the row keeps the metadata but the sensitive document
  only lives while the request is open. Files touched:
  `internal/store/callsign_requests.go` (new `callsign_requests` table
  + migration), `internal/server/callsign_requests.go` (handlers),
  `internal/server/{auth.go,audit.go,server.go,main.go}` (permission,
  audit actions, routes, proofs-dir plumbing),
  `internal/server/web/{index.html,app.js,i18n.js}` (settings card,
  admin screen, EN/DE i18n with informal "du" strings).
- **Contest exchange numbers now appear in ADIF and CSV exports —
  FR #67 (dl8aa).** `QSO.NrSent` / `QSO.NrReceived` were populated by
  the logging path but silently dropped from both exports. ADIF now
  emits `<STX:n>{nr}` for a non-zero sent number and `<SRX:n>{nr}` for
  a non-zero received number. CSV gains two new columns, `nr_sent` and
  `nr_received`, inserted after `rst_received` so the running numbers
  sit next to the reports they belong with. Zero values are omitted
  so non-contest / imported QSOs don't leak a spurious `<STX:1>0`.
  Third-party scoring tools (DXKeeper, Log4OM, Tucnak) now receive
  the sequence instead of only the RST.
- **ADIF lighthouse: bare `<ARLHS>` → `SIG=ARLHS` + `SIG_INFO=<ref>`.**
  ADIF has no dedicated lighthouse field; bare `<ARLHS>` tags were
  invented by early loggers and get rejected by strict validators
  (DXKeeper, Log4OM). The idiomatic mapping is the Special Interest
  Group pair, mirroring the SOTA-in-SIG / POTA-in-SIG pattern.
- **ADIF mode/submode split for FT8, FT4, PSK31/63/125, JT65A/B/C,
  JT9A, USB, LSB.** Per the ADIF Mode enumeration, digital variants
  are not standalone modes: FT8/FT4 are SUBMODEs of MFSK; PSK31/63 of
  PSK; JT65A/B/C of JT65; USB/LSB of SSB. Emitting `<MODE:3>FT8` was
  not a legal enum value and strict importers rejected the whole
  record. New `adifModeSubmode()` helper returns the correct pair;
  plain analogue modes (CW, SSB, AM, FM, RTTY) pass through unchanged
  with no SUBMODE.
- **Notes now map to ADIF `NOTES`, not `COMMENT`.** ADIF distinguishes
  COMMENT (QSO-relevant remarks — signal conditions, equipment) from
  NOTES (general operator notes). Our field is a free-form text box,
  so NOTES is the accurate mapping and what LotW/eQSL importers
  expect.
- **`CONTEST_ID` is validated against the ADIF enum with a NOTES
  fallback.** Previously the free-form contest name landed in
  `<CONTEST_ID>`, so records for local DARC OV activities (WSA 2026,
  Notfunkübung, ...) were rejected by strict importers. A curated
  whitelist of ~40 ADIF `Contest_ID` values covers DARC (WAEDC, WAG,
  FT4), IARU, EU-HF/PSK, CQ (WW, WPX, 160), ARRL, RSGB, REF and SAC.
  Lookup via `normaliseContestKey()` is case- and separator-
  insensitive so "cq ww cw" hits `CQ-WW-CW`. On miss,
  `"Contest: <name>"` is prepended to `NOTES` (with a newline before
  any existing content), so the information isn't lost — it just
  isn't machine-indexable as a contest.
- **`MY_GRIDSQUARE` is emitted from the contest QTH.** Every award
  tracker (LotW, eQSL, VUCC, DXCC-from-here) reads `MY_GRIDSQUARE` to
  credit worked-grids and DXCC-from-QTH. We had the value on the
  session (`sess.ContestQTH()`, used already by the PDF export) but
  never threaded it into `ExportADIF`. Now emitted uppercased once
  per QSO; empty QTH is a no-op so non-contest exports are
  unaffected. `ExportADIF` signature grows a trailing `myGridsquare`
  string parameter — the only production caller is `handleExportADIF`.
- **UTF-8 in ADIF `NAME` and `NOTES` uses the `_INTL` variants.**
  Per ADIF 3.1.x, `NAME` and `NOTES` are ASCII-only `String`. Values
  with umlauts ("Jörg", "schöner Kontakt") or accents ("José")
  violate that and can round-trip as mojibake through strict readers.
  ADIF 3.1 added `NAME_INTL` and `NOTES_INTL` as `IntlString`
  (UTF-8 permitted). New `hasNonASCII(s)` helper picks the right
  variant per field; pure-ASCII values still land in the plain
  `<NAME>` / `<NOTES>` tags so downstream tools aren't forced onto
  the `_INTL` parser unnecessarily.
- **New regression tests for every ADIF fix.** New file
  `internal/server/export_test.go` covers STX/SRX presence and
  omission, `SIG` + `SIG_INFO`, mode/submode split (FT8, FT4, PSK31,
  PSK63, USB, LSB, CW/SSB/FM pass-through), NOTES vs COMMENT,
  CONTEST_ID enum lookup with case/separator insensitivity,
  unknown-contest NOTES fallback, `MY_GRIDSQUARE` presence/absence,
  and `_INTL` variants for `NAME` and `NOTES`. 14 test cases total.
- `programVersion` bumped to `0.68`

## v0.67 — 2026-06-23 — Modal robustness — Edit Contest no longer wedges focus

- **Modal becomes unresponsive after editing from the Map tab —
  fixed.** Reported live: a user on the Map tab clicks the station
  pill to open "Edit Contest", clicks into an input, then cannot
  escape the modal via keyboard shortcuts; only a page reload
  restores normal interaction. Root cause was a stack of small
  gaps in `internal/server/web/app.js::showModal`:
- **`close()` now blurs the focused element first.** Toggling
  `.hidden` (`display: none !important`) on the wrapper while
  focus is still on an input inside it leaves some browsers with
  `document.activeElement` pointing at a now-hidden node;
  subsequent keystrokes go to nowhere. `document.activeElement
  ?.blur()` before adding `.hidden` lets focus deterministically
  return to `<body>`.
- **The modal-card carries its own Esc keydown.** The pre-existing
  document-level Esc handler at line ~3462 is the only Esc binding
  in the app; if any ancestor `stopPropagation`s the keydown the
  listener never fires. The new `card.onkeydown` runs before
  bubbling escapes the modal and is a hard guarantee Esc always
  closes.
- **Backdrop click closes.** `modal-root` gets an `onclick` that
  fires only when `e.target === root` (clicks inside the card
  never bubble with that target), giving operators the standard
  centred-dialog dismiss affordance.
- **First input is auto-focused.** A `setTimeout 0` after the
  modal renders focuses the first non-disabled input/select/
  textarea inside `modal-card`. Operators always see where their
  keystrokes will land, and Esc / Tab have a real `activeElement`
  to bubble from.
- **Handlers are cleared on close** — `modal-root.onclick = null`
  and `card.onkeydown = null` in the `close()` path so listeners
  do not accumulate across the many modals a session opens.
- The document-level Esc handler stays in place as a second layer
  for callers that bypass `showModal` (the confirm dialog, the
  deploy-countdown ribbon). Map / globe canvas listeners are
  untouched — they only act on canvas-targeted events and never
  saw modal traffic.
- `programVersion` bumped to `0.67`

## v0.66 — 2026-06-23 — Umlauts in export filenames are readable on every client

- **Transliterate German umlauts in the legacy `filename=` fallback.**
  Reported live by operators downloading exports: filenames arrived
  on disk as "Notfunk_bung.pdf" instead of "Notfunkübung.pdf" — every
  umlaut became an underscore. The v0.60 fix for FR #57 already
  emits the RFC 6266 dual form
  `filename="…"; filename*=UTF-8''<percent-encoded>` and RFC 5987-
  compliant clients pick the second parameter. In practice though,
  some download managers, corporate proxies and older browser
  builds use the legacy `filename=` value, and the previous
  ASCII-fallback in `internal/server/server.go::attachmentDisposition`
  collapsed every non-ASCII rune to `_`.
- The fallback now transliterates the four umlauts and ß instead:
  `ä→ae`, `ö→oe`, `ü→ue`, `Ä→Ae`, `Ö→Oe`, `Ü→Ue`, `ß→ss`. Anything
  still non-ASCII after that step remains `_`. Modern clients pick
  the unchanged `filename*=UTF-8''…` parameter and see the exact
  original name; legacy / proxy paths now produce
  "Notfunkuebung.pdf" — readable instead of "Notfunk_bung.pdf".
- New `TestAttachmentDispositionTransliteratesUmlauts` in
  `internal/server/validate_test.go` locks both halves of the
  Content-Disposition value against regression.
- Transliteration is German-specific (ä/ö/ü/ß) rather than full
  ICU, matching the DARC-region operator base whose contest names
  realistically contain these letters and not, say, ç or 漢字.
- `programVersion` bumped to `0.66`

## v0.65 — 2026-06-23 — Personal Settings save works for regular users

- **Save button restored in Personal Settings for non-admin users.**
  Reported live during v0.62 testing: a regular user opening Personal
  Settings could see the new Theme and QSO-time-input dropdowns
  added in v0.61 / v0.62, but no Save button. Root cause: the Save
  button on this card carried `class="perm-required"
  data-perm="settings.write"` from a time when the form only
  persisted the global `default_mode` / `default_band` settings.
  When v0.61 (FR #29) and v0.62 (FR #65) bolted on per-user prefs,
  the gate was not lifted, so non-admins lost the ability to save
  per-user prefs they were otherwise free to change.
- **internal/server/web/index.html** — the `default_mode` and
  `default_band` `<label>`s gain
  `class="perm-required" data-perm="settings.write"` so non-admins
  no longer see two selects they cannot persist. The Save button
  (line 954) drops its `perm-required` attribute and is now always
  visible. The admin-only **Global Settings** card on line 627
  keeps its gate untouched — that path remains admin-only.
- **internal/server/web/app.js** — the `ms-settings-form` submit
  handler now branches on `hasPerm('settings.write')` before
  PUTing the global `/api/settings` endpoint. Non-admins skip
  that step silently (their default selects are hidden, so any
  stale value never reaches the server). The subsequent
  `PUT /api/me/time-input-mode` and `PUT /api/me/theme` calls were
  already correctly per-user-authenticated and now run for every
  user once the surrounding handler is no longer short-circuited
  by a 403.
- Result: a regular user picking "Light theme" or "Local time"
  in Personal Settings clicks Save and the choice persists live —
  the theme flips immediately, no error pill, no phantom Save
  button.
- `programVersion` bumped to `0.65`

## v0.64 — 2026-06-23 — Hand off a contest config via chat

- **"Send to chat" on every share row, with an Apply button on the
  receiving end (FR #23).** dj3nu asked for a way to push a contest
  setup to another OM through the live chat — a portable operator
  joining the WSA mid-session should skip the whole layout / bands /
  custom-fields configuration and adopt the host's instead. The
  share-link infrastructure from v0.55 already mints token-bearing
  URLs the importer can paste into their contest picker; this
  release wires that flow directly into the chat channel so the
  recipient sees a one-click card rather than a generic URL.
- **Sender side** — every existing share row in the contest share
  modal (`internal/server/web/app.js::contestShareModal`) grows a
  ghost "Send to chat" button next to Copy / Revoke. The button is
  shown only when this share's contest is also the operator's
  *active* contest (`me.contest_id === c.id`); chat is per-contest,
  so offering the action from a different room would deliver to
  nobody. On click it emits a plain-text chat message via the
  existing WebSocket channel with the format
  `[noctalum-cfg:TOKEN:Contest Name]`. `buildConfigOfferText()`
  strips `]` and `:` from the name part so the receiver's regex
  stays unambiguous. The button briefly flips to "Sent ✓" for
  1.5 s on success.
- **Receiver side** — `appendChatMessage()` now matches every
  incoming chat body against
  `/^\[noctalum-cfg:([A-Za-z0-9_-]+):([^\]]*)\]$/`. On match it
  suppresses the raw sentinel and builds an inline card inside the
  chat body: a 🛠 label ("Contest config offered: <Name>") plus a
  primary button ("Apply this config"). The button click opens the
  existing `contestImportShareModal(token)`, whose flow already
  fetches the share, previews it, and asks for the importer's own
  `station_call` + `qth` + new contest name before POSTing
  `/api/import-share`. Plain chat messages keep the previous
  `textContent` path — only the strictly-matched sentinel format
  takes the card branch, so a square-bracket-typing operator
  cannot accidentally trigger an offer.
- **History replay** routes through the same `appendChatMessage`,
  so config-offer messages still in the rolling 24 h chat window
  re-render as cards on reconnect.
- **i18n** — new keys `chat.configOffered`, `chat.applyConfig`,
  `contestScreen.shareSendChat`, `contestScreen.shareSentChat`
  (EN + informal-DE). The DE phrasing uses "Konfig übernehmen" —
  the natural German verb for adopting a pre-built configuration.
- **CSS** — new `.chat-cfg-card` inside `style.css`: an accented
  panel with the label on top and the button below, using
  `var(--accent-dim)` / `var(--accent)` so it re-skins
  automatically under the v0.62 light theme.
- **Security note.** The sentinel itself is not a credential —
  anyone can type `[noctalum-cfg:fake:test]` and produce a card.
  The real authentication is the existing `/api/import-share`
  endpoint, which validates the token server-side; a revoked or
  forged token simply produces the import modal's existing
  "share not found" error.
- **No backend or schema change.** Chat-message storage stays
  text-only; the sentinel is a convention on top of the existing
  channel. This release is pure frontend.
- `programVersion` bumped to `0.64`

## v0.63 — 2026-06-23 — Distance column + EU DX preset

- **Per-QSO Distance column in the log table and PDF (FR #60c).**
  dg4dy suspected the WSA contest results were claiming every QSO
  sat within 50 km of their JO31PL QTH and asked for the locators
  to be verified. The audit (32 QSOs in contest 22, WSA 06/2026)
  computed the great-circle distance from JO31PL to each QSO's
  locator and found 8 are actually beyond 50 km — DF0WN @ JO42GE at
  116.5 km, DK2NI @ JO31SW at 53.8 km, DO2EN @ JO32WB at 76.3 km,
  DL1DBR @ JO41BN at 58.4 km, DL0GX @ JO31LV at 51.7 km (the latter
  three each logged on multiple bands). The app's bearing-panel
  `#distance-value` already showed the right km value for the *live*
  target — there was no math bug — but no per-row distance was ever
  surfaced, so the operator's only visual cue was the worked-stations
  map's auto-fit zoom, which clusters dense JO31 traffic and hides
  the handful of outliers. This commit adds an optional "Distance"
  column (default off, label "km") to `builtinLogColumns` in
  `internal/server/log_columns.go` and `LOG_COL_DEFS` in
  `internal/server/web/app.js`. Value renderers — `qsoColValue` (JS)
  and `qsoColValuePDF` (Go) — compute the great-circle km on the fly
  from the contest's `qth` to the QSO's locator and emit it as
  "%d km" rounded. The Go side ships new
  `LocatorToLatLon` / `DistanceKm` / `LocatorDistanceKm` helpers in
  `internal/server/validate.go` that match the JS
  `locatorToLatLon` / `distanceTo` pair bit-for-bit (R = 6371 km,
  same haversine, same 1/24+1/48 sub-square centre offsets), so the
  same QSO reports the same km in the browser and in the PDF. New
  `TestLocatorDistanceKm` in `validate_test.go` locks the audit
  numbers (JO31PL → JO42GE ≈ 116 km) against regression. PDF column
  widths and right-alignment match the other numeric columns.
- **EU DX Contest preset (FR #58).** dl8aa pointed out that the EU
  DX Contest (https://www.eudx-contest.com/) uses a "RST DE10" /
  "RST IT21" region-code exchange that did not fit the Nr-sent /
  Nr-rcvd fields. The custom-fields machinery from v0.55 + the
  ADIF / CSV custom-field round-trip from v0.60 already covered the
  data shape; the friction was setup. This commit introduces a
  `CONTEST_PRESETS` table at the top of the contest-create modal
  in `internal/server/web/app.js`. Each entry describes a name,
  band list, and one or more custom fields. The EU DX entry ships:
  bands `80m, 40m, 20m, 15m, 10m` (the contest's HF bands; 6 m
  intentionally omitted), one required `text` field
  `region_code` (label "Region"). The modal grows a "Preset"
  `<select>` at the top with `(none)` plus one option per
  preset. On change, the handler fills the contest name (only if
  still empty, so half-typed input survives), toggles the
  `#modal-band-grid` pills to match the preset's bands, and
  rebuilds the `.cf-editor-rows` HTML with the preset's fields —
  any previously-half-entered custom field is intentionally
  overridden because the operator just picked a preset. EN + DE
  i18n keys (`contestScreen.preset`, `presetHint`, `presetNone`,
  `presetEUDXName`); DE labels use the informal voice
  ("Vorlage" / "(keine)"). Exchanges like `59 DE10` now round-trip
  through ADIF as `APP_NOCTALUM_REGION_CODE` (already wired by the
  v0.59 / v0.60 export plumbing) and as a `region_code` column in
  CSV — no new export-side code.
- `programVersion` bumped to `0.63`

## v0.62 — 2026-06-23 — Light theme, finished-log inspect, helper UX

- **Per-user light / high-contrast theme.** dg4dy (FR #65) reported the
  default dark theme is unreadable in direct sunlight when operating
  from the field. New `theme` column on `users` (default `'dark'`, so
  existing installs roll forward unchanged), new `PUT /api/me/theme`
  endpoint (accepts `dark` or `light`, rejects anything else), new
  "Theme" dropdown in the personal-settings card. CSS implementation:
  `body.theme-light` overrides every palette variable to a near-white
  background / near-black text scheme (`--bg #f7f8fa`, `--bg-elev
  #ffffff`, `--text #1a1d22`, `--accent #1565c0` — Material Blue 800,
  AA against white at body and label sizes); the dark theme's tinted
  radial wash baked into the login / contest-picker backgrounds is
  neutralised under `theme-light` so it doesn't read as a smudge.
  Every existing rule that references `var(--…)` flips automatically
  — modals, cards, tables, pills, inputs, the QSO grid, the layout
  editor, audit log, and the read-only banner all re-skin without
  per-element edits. `applyTheme()` in `app.js` toggles the body class
  on `/api/me` load and after a successful settings save.
- **Closed contests are browsable again.** dl8aa (FR #62) noted that
  clicking a QSO row in a finished contest only refreshed the QRZ
  photo — country flag, locator, distance and the great-circle line
  all stayed frozen on whatever the previous click left behind. The
  read-only branch in `renderQsos`' click handler in
  `internal/server/web/app.js` now mirrors the editing branch's
  display-only side-effects: `triggerQRZLookup(q.callsign)` for the
  photo and name, `updateCallCountry(q.callsign)` for the flag,
  `currentTargetLocator = q.locator` + `updateMap()` for the
  bearing line and km. The form stays disabled (already gated by
  `applyContestReadonly()`), so this is purely browse-mode without
  any path to mutate stored data.
- **Reopen-for-editing button on the finished-contest banner.** Same
  FR — operators previously had to leave the contest and use the
  picker's toggle to flip a finished contest back to writable. The
  `contest-readonly-banner` in `index.html` now carries a
  `class="ghost small perm-required" data-perm="contests.manage"`
  button labelled "Reopen for editing" / "Zum Bearbeiten wieder
  öffnen" (informal "du" in DE). The click handler in `app.js`
  fetches the full contest record via `GET /api/contests/<id>`,
  resubmits it with `status: "open"` (the existing UpdateContest
  validates the whole record, so a status-only PUT would 400 on the
  StationCall check at `server.go:2783`), and lets the WS
  `contest_updated` event flip `me.contest_status` and re-run
  `applyContestReadonly()` — no client-side state mutation needed.
- **Helper makes clear it connects to the Noctalum server, not
  localhost.** dg4dy (FR #63 / #64) was confused by the cryptic
  startup sequence `ws dial: dial tcp [::1]:8080: …` and had
  accidentally pointed the helper's Server URL field at
  `http://localhost:8080`, assuming the helper talked to the
  browser on the same machine. `cmd/helper/main.go` and
  `cmd/helper-gui/session.go` now wrap the `websocket.DefaultDialer`
  error with the configured URL: `ws dial to %s: %w`. The
  helper-gui's index.html grows an inline 11 px hint under the
  Server URL `<input>`: *"URL of the Noctalum server (e.g.
  https://log.dm2lap.com), not your local browser — this helper
  relays the rig's frequency to the server."* New `.field-hint`
  style added to `cmd/helper-gui/frontend/dist/style.css`.
- `programVersion` bumped to `0.62`

## v0.61 — 2026-06-23 — QSO entry hardening: local-time mode, band/freq guard, lookup race fix

- **Per-user UTC vs local-time pick for the QSO time field.** The
  optional date/time tile is rendered by `<input type="datetime-local">`,
  which most browsers display in the *local* time zone; the submit path
  used to append a `Z` and treat the typed value as UTC, so an operator
  in CEST who entered "14:30" got 14:30Z stored instead of the intended
  12:30Z. dl8aa (FR #29) asked for an explicit choice. New
  `time_input_mode` column on `users` (default `'utc'`, no behaviour
  change for existing rows), new `PUT /api/me/time-input-mode`
  endpoint, new "QSO time input" dropdown in Personal Settings (EN +
  informal-DE), new `localDateTimeInputValue()` + `updateQTimeLabel()`
  helpers in `app.js`. The QSO time tile's label now flips between
  "UTC date & time" and "Local date & time" so the operator can see
  the active frame at a glance. Storage of `QSO.time` is always UTC.
- **Reject QSOs whose frequency does not match the selected band.**
  dl8aa (FR #41) noted that with 20 m selected, a 2 m frequency went
  through unchallenged. `internal/server/server.go`'s QSO insert and
  update paths now run a `BandFromHz()` consistency check after the
  existing band-fallback block: if the inferred band is non-empty and
  differs from `in.Band`, the request is rejected with
  `frequency X.XXX MHz is in the <inferred> band, not <selected>`.
  Out-of-band frequencies (no band match) are *not* rejected, matching
  the existing latitude for monitoring / off-band contacts.
- **Lookup race fix — wrong DOK after callsign change.** dg4dy (FR
  #60a) repeatedly saw the previous callsign's DOK end up in the
  current QSO's DOK field. The pre-existing guard at line 3596 of
  `app.js` only compared `q-call.value` to the in-flight lookup's
  callsign string, which a brief edit-and-retype could defeat.
  Introduces a monotonic `_qrzLookupSeq` counter: `triggerQRZLookup()`
  bumps it and remembers its own ticket; on response, mismatch ⇒
  discard. `clearQRZInfo()` also bumps the counter so an in-flight
  lookup cannot resurrect just-wiped fields after the operator hits
  "Log QSO" or backspaces the callsign below 3 chars. The string
  match guard stays in place as a second layer.
- **Band `<select>` repopulates when the contest's band list
  changes.** dg4dy (FR #60b) added 23 cm to the WSA contest post-hoc
  and could not edit existing QSOs onto the new band — the dropdown
  was frozen on the set present at last `applyDefaults()` call. New
  `refreshContestBandSelect()` in `app.js` rebuilds the `<select>`
  preserving the current selection if it survives the new band list;
  called from the `contest_updated` WebSocket branch when
  `'bands' in msg.payload`. `applyDefaults()` itself is unchanged.
- **Date input fits its grid cell on every browser.** dl8aa (FR #46)
  reported the optional date/time field overflowed its `defaultW: 3`
  grid slot — caused by `step="1"` forcing a seconds spinner on top
  of the existing year/month/day/hour/minute controls. Switched to
  `step="60"` (minute precision) in `index.html` and corresponding
  `substring(0, 16)` truncation in `loadQsoIntoForm`. Storage format
  unchanged; the submit handler already accepted both shapes.
- **German RST labels normalised to the abbreviated form.** dl8aa
  (FR #56) noted that the QSO entry form mixed long ("RST gegeben"
  / "RST empfangen") and short ("Nr geg." / "Nr empf.") labels. The
  two RST keys in `internal/server/web/i18n.js` are now `RST geg.` /
  `RST empf.` to match the Nr style. EN catalogue ("RST sent" /
  "RST rcvd" / "Nr sent" / "Nr rcvd") was already consistent.
- **FR #21 verified already implemented in v0.55** — Tab order in
  the QSO entry mask follows the saved layout (via `applyQSOLayout()`
  in `app.js`), and Enter from band/mode dropdowns submits the form
  (`qso-form keydown` handler around line 3360). No code change in
  this release; the feature request was simply still open in the DB.
- `programVersion` bumped to `0.61`

## v0.60 — 2026-06-23 — Export polish, smarter QSO filter, portable callsigns

- **ADIF export carries the DOK.** `internal/server/export.go::ExportADIF`
  now writes the QSO's DOK as `<DARC_DOK:n>VALUE`, the de-facto convention
  used by DXKeeper, Log4OM, HamRadioDeluxe and Tucnak. Previously the
  field was silently dropped from ADIF even though DOK is a first-class
  column on `store.QSO` and round-trips through the UI and PDF exports.
  Emitted only when non-empty so non-DARC contests are unchanged.
  (FR #54, reported by dl8aa.)
- **CSV export gains a `dok` column** in
  `internal/server/export.go::ExportCSV`, inserted between
  `rst_received` and `locator`. Consumers that key on the header name
  are unaffected; consumers that index by position need to shift right
  by one starting at the locator column. Value is upper-cased to match
  the ADIF tag and the on-screen column. (FR #55, dl8aa.)
- **Umlauts in export filenames survive the download.** The PDF, ADIF,
  CSV, Cabrillo and EDI export endpoints previously emitted
  `Content-Disposition: attachment; filename="Notfunkübung … .pdf"` with
  the umlaut as raw UTF-8, which most browsers re-decoded as latin-1 and
  saved as `NotfunkÃ¼bung … .pdf`. New
  `internal/server/server.go::attachmentDisposition` builds the RFC 6266
  dual form — an ASCII fallback (non-ASCII → `_`) plus
  `filename*=UTF-8''<percent-encoded>` — so legacy clients still get a
  usable filename and modern clients decode the original UTF-8 string.
  (FR #57, dl8aa.)
- **PDF map page uses substantially less toner.** Follow-up to v0.59's
  switch to a white-background map: `renderPdfMapCanvas` in
  `internal/server/web/app.js` now sources tiles from CartoDB
  `light_nolabels` instead of `light_all`, dropping the dense
  place-name labels that accounted for most of the dark pixels on a
  printed log page. Country borders and coastlines remain. (FR #53,
  dl8aa.)
- **QSO history filter no longer false-matches via the operator
  field.** The old implementation concatenated callsign, band, mode,
  operator, locator and DOK into a single haystack and substring-tested.
  For an operator named "DL8AA" that meant filtering for "DL" matched
  *every* QSO because the substring lived in the operator field —
  exactly the symptom dl8aa reported in FR #59. The new
  `qsoMatchesFilter` helper splits the typed filter on whitespace and
  matches each token independently: callsign/band/mode/locator/DOK use
  prefix match; operator requires an exact full-callsign match. Bonus:
  multi-token filters now AND together, so `dl 40 cw` narrows by all
  three.
- **Callsigns with slashes accepted everywhere applicable.** The
  validator regex in `internal/server/validate.go` previously allowed
  one trailing portable suffix (`DM2LAP/P`) but rejected leading ITU
  prefixes (`F/DM2LAP`) and double-prefixed forms (`F/DM2LAP/QRP`),
  closing the door on visiting-operator logs. The new grammar is
  `[PREFIX/]BASE[/SUFFIX[/SUFFIX...]]` with PREFIX a 1–4 char ITU
  country prefix and SUFFIX one or more portable/status tokens; the
  base still must contain a digit and end on a letter, so degenerate
  inputs like `F/F` or `/DM2LAP` remain rejected. Max length raised
  from 16 → 20. A new `BaseCallsign()` helper returns the longest
  /-separated token with a digit (≥3 chars), and the lookup endpoint
  now passes that to QRZ and the DOK cache so portable QSOs still
  resolve to the operator's home record. New
  `internal/server/validate_test.go` locks both behaviours against
  regressions. (FR #66, dm2lap.)
- **Deploy script ships the production compose file.** Previously
  `deploy.sh` unconditionally scp'd the repo-root `docker-compose.yml`
  (the dev variant) onto the server, overwriting the production compose
  and detaching the noctalum container from Traefik on every deploy.
  The repo now versions `docker-compose.prod.yml` separately (container
  name `noctalum`, `restart: unless-stopped`, attached to the external
  `proxy` network with the Traefik router/service labels for
  log.dm2lap.com), and `deploy.sh` scp's that file under the name
  `docker-compose.yml` the server expects.
- **SSH keys are gitignored.** Explicit `/id_noctalum` and
  `/id_noctalum.pub` entries added next to `.deploy.env` so the
  private key used for production SSH is never tracked accidentally.
- `programVersion` bumped to `0.60`

## v0.59 — 2026-06-11 — Map tab, 3D globe, PDF map page, helper-token restored

- **Map tab (2D)**: new contest-view tab between Statistics and Export. Renders
  a full-screen Leaflet/CartoDB dark world map with the operator's own QTH
  (green pin, derived from `me.contest_qth`) and one band-coloured dot per
  QSO that has a locator (`BAND_COLORS` lookup over the 17 `BANDS` entries).
  Dashed great-circle paths from own QTH to each worked station are drawn
  below the dots using the existing `greatCirclePoints()` /
  `splitAtAntimeridian()` helpers. The fixed-width legend panel includes a
  "Show paths" toggle plus one per-band checkbox; filter state lives in
  `contestMapState`, persists across tab switches, and resets when joining
  a different contest. Path/dot toggling adds/removes Leaflet layers in
  place rather than rebuilding the map.
- **3D globe sub-tab**: new "2D" / "3D" buttons above the map canvas.
  The 3D view is a pure JS/Canvas orthographic globe — no extra library —
  drawing the ocean gradient, lat/lon graticule, Natural Earth 110m land
  polygons + per-country borders (`world-countries.geojson`, 177 features,
  geometry-only), band-coloured dashed great-circle paths, and band-coloured
  QSO dots sorted back-to-front. Mouse drag rotates longitude/latitude;
  mouse wheel and pinch zoom (range 0.5×–8×) grow R (sphere radius) so the
  globe behaves like Google Earth — the sphere extends beyond the canvas
  edge once zoomed in. Country labels (`world-country-labels.json`) appear
  progressively per `LABELRANK` with logarithmic font scaling and greedy
  anti-overlap; `NAME_DE` is used when the app runs in German.
- **Click tooltips on map dots**: 2D map dots gain both a hover tooltip
  (callsign + band) and a click popup (callsign, time UTC, band/mode, RST,
  locator, name, DOK, op). 3D dots show the same detail in a fixed
  floating tooltip (`#cmap-qso-tip`); clicking the QTH dot shows own
  callsign and locator. Drag does not trigger the click handler.
- **Multi-band pie-chart dots**: when two or more QSOs share the same
  Maidenhead grid square, their dot is now a pie chart with one equal
  sector per distinct band colour, drawn clockwise from 12 o'clock.
  Implemented consistently across all three rendering paths: 2D Leaflet
  (per-location `L.divIcon` with inline SVG via `_pieSvg`/`_pieDivIcon`),
  3D globe (`_drawPie` after back-to-front sort), and the PDF map
  (`tmpMap.latLngToContainerPoint()` + `_drawPie` on the output canvas).
  `applyContestMapFilters()` updates the icon live when a band is toggled.
- **PDF export — optional map page**: new "Include map (extra page)"
  checkbox in the export card. When checked, the download intercepts the
  click, builds an off-screen Leaflet map at 1400 × 800 with the same
  CartoDB tiles + vector paths + pie-chart dots as the live map, captures
  it to a canvas, and POSTs `{mapImage: <base64 PNG>}` to
  `/api/export/pdf`. The Go side decodes the image via
  `decodeBase64Image()` and appends a final page with a simplified header
  (logo + "Noctalum", no column row) and the translated page title
  ("Worked Stations Map" / "Karte gearbeiteter Stationen").
- **PDF map — print-friendly white theme**: the map page now uses
  CartoDB's `light_all` basemap instead of `dark_all`; fallback fill,
  legend strip, divider stroke, legend text, and the on-map QTH marker
  all switch to a light theme so the printed page stays clean. The
  in-app live map is unchanged.
- **PDF export — drag-and-drop column picker**: the export column picker
  is now a vertically-sorted draggable list (HTML5 DnD). Initial order
  comes from the contest's `log_columns`, the `?cols=…` URL param
  reflects the drag order, and a "Reset to defaults" button re-renders
  from scratch. New `export.col*` i18n keys give the German labels full
  names (Rufzeichen, Gesendetes RST, Empfangenes RST, Locator, Frequenz,
  Betriebsart, Operator) — the QSO history table abbreviations are
  untouched.
- **Helper token restored to Personal Settings**: the "My helper token"
  panel was orphaned in `#tab-settings` when that tab's nav button was
  removed in 8ae1065. It is now re-exposed as its own card in
  `#my-settings-screen` (reachable via the contest-picker nav pill) with
  `ms-`-prefixed IDs so it coexists with the still-present legacy block;
  `loadMySettings()` populates the input from cached `me.helper_token`
  and Regenerate keeps the legacy `s-token` / `hint-token` in sync.
- **ADIF + CSV exports — custom fields included**: per-QSO custom field
  values defined on the contest now ride along in `/api/export/adif`
  (emitted as `APP_NOCTALUM_<NAME>` application-defined fields, with
  non-`[A-Z0-9_]` characters replaced by underscore) and `/api/export/csv`
  (one extra column per defined field, header named after the field's
  stable `name`). Cabrillo and EDI are deliberately left alone — their
  fixed-column layouts are sponsor-defined. New `parseCustomFieldDefs`
  helper in `log_columns.go` is shared by the column resolver, ADIF, and
  CSV paths.
- **Security: shutdown endpoint replaced with file-based trigger**: the
  unauthenticated `POST /api/shutdown` endpoint relied on Docker's
  host-side port binding for safety — one mis-mapped port and a remote
  caller could kill the server. It is removed. Instead the server polls
  `<data-dir>/shutdown_trigger` every 2 seconds; the file's first line is
  the countdown in seconds. Behaviour is preserved exactly (deploy
  warning WebSocket broadcast, modal countdown, SIGTERM after countdown).
  `deploy.sh` now writes the file via SSH instead of `curl`. Triggering
  shutdown now requires SSH access to the host — already a deploy
  prerequisite.
- **Chore: deploy.sh re-added with secrets in `.deploy.env`**: `deploy.sh`
  was removed in 7b246cf because it baked in `SSH_KEY`, `SSH_HOST`, and
  `REMOTE_WORK_DIR`. It is back, with those three values sourced from a
  gitignored `.deploy.env` next to the script; `.deploy.env.example` is
  committed as the template. No functional change to deploy logic.
- `programVersion` bumped to `0.59`

## v0.58 — 2026-06-02 — QRZ autofill accuracy and bearing distance polish

- **QRZ autofill — immediate wipe on callsign change**: when the operator edits
  the callsign field (≥ 3 chars), any previously auto-filled name, locator, and
  DOK are now cleared immediately before the new debounced lookup fires. The old
  wipe-on-not-found path in `triggerQRZLookup` only fired when the new callsign
  had no QRZ entry; if the intermediate callsign also had an entry the stale data
  from the previous lookup persisted indefinitely. Fix is in the `q-call` input
  handler in `app.js`.
- **QRZ autofill — wipe on final callsign with no entry**: introduced
  `_qrzAutoFilled`, a variable tracking which field values (name, locator, DOK)
  were auto-populated by the last successful lookup and what those values were.
  When the lookup returns `j.found = false`, the name and locator fields are
  cleared only if they still hold the auto-filled value (user-modified values are
  never touched). When `j.cached_dok` is absent the DOK field is cleared the same
  way. The QRZ pill and left panel are also hidden. This covers the case where a
  partial callsign (e.g. "DL1") produced a hit but the full callsign ("DL1XYZ")
  has no entry.
- **Bearing panel distance always in km**: the panel previously switched to
  Megameters (Mm) for distances ≥ 1000 km. Mm is not a standard amateur-radio
  unit; the display now unconditionally uses `Math.round(dist) + ' km'`.
- `programVersion` bumped to `0.58`

## v0.57 — 2026-06-02 — Deploy warning system, frequency unit selector, and distance display

- **Deploy warning system**: `POST /api/shutdown` (localhost-only, no secret required) broadcasts
  a 60-second countdown to all connected browsers before the server restarts. The modal dismisses
  to a persistent caution-stripe ribbon that survives page refreshes (sessionStorage). After the
  countdown the client polls the new unauthenticated `GET /api/ping` endpoint, which returns a
  per-process `startup_id`; as soon as the ID changes (or a network error followed by recovery),
  the page reloads automatically — covering both slow and fast restarts. WS connection is now also
  established on the contest-picker screen so the warning reaches users who have not yet joined a
  contest.
- **Per-contest frequency unit**: contest settings have a new Hz / kHz / MHz / GHz selector stored
  in a new `freq_unit` DB column (SQL migration, default `kHz`). The selected unit is propagated
  everywhere: QSO form label, log column header, log display, stash, rig auto-fill, spot clicks,
  band-mismatch validation messages, and PDF exports. Duplicating a contest inherits the source
  unit; shared contests carry the unit in the share payload.
- **Distance to target**: the left bearing panel now shows the great-circle distance to the target
  locator (haversine formula) in km, or Mm for distances over 1 000 km. Resets to "—" when no
  target locator is set.
- **QRZ callsign race condition fixed**: if a slow QRZ HTTP response arrives after the operator
  has already moved to a different callsign, the stale result is silently discarded. A blur
  listener on the callsign field also fires a final definitive lookup when the field loses focus.
- **Band dropdown repopulation fix**: `applyDefaults()` is now called at the top of `enterApp()`
  so the band dropdown is always rebuilt from the current contest's allowed bands, even when
  entering via the contest picker rather than a page load.
- **Contest screen layout polish**: action buttons given equal width via `flex:1`; contest footer
  anchored to viewport bottom; ribbon height and pill padding reduced for a tighter layout.
- `programVersion` bumped to `0.57`

## v0.56 — 2026-06-01 — Contest-aware band selector and out-of-band frequency warning

- Band dropdown in the New QSO form now lists only the bands configured for the
  active contest. `applyDefaults()` in `app.js` passes `contestBands()` to
  `fillSelect` for `q-band` instead of the global `BANDS` constant; falls back
  to the full list when no contest bands are configured
- New "NOT A CONTEST BAND" / "KEIN CONTEST-BAND" amber warning pill sits next to
  the duplicate badge and fires whenever the typed (or rig/spot/stash-supplied)
  frequency maps to a valid amateur band that is not in the contest's band list.
  `updateOobBadge()` is wired into `q-freq` input, cluster-spot load, stash
  recall, QSO edit load, cancel-edit, post-submit clear, and
  `applySelectedRigToForm()`. CSS class `.oob-band` in `style.css`; i18n key
  `qso.outOfBand` in EN ("NOT A CONTEST BAND") and DE ("KEIN CONTEST-BAND")
- Internal: `/release` skill instruction tightened — in-app `CHANGELOG` `en`/`de`
  strings must now be short scannable bullets (one user-visible effect per line,
  under ~15 words each, no code identifiers). The Telegram notifier posts the DE
  string verbatim; the previous prose-essay format was unreadable in a group chat
- `programVersion` bumped to `0.56`

## v0.55 — 2026-05-29 — Contest config reuse, QSO entry polish, and settings-save preservation

### QSO entry mask
- Date/time tile no longer bursts its 3-column slot — `min-width: 0` now propagates to the `<input>` / `<select>` children so native `datetime-local` collapses to the grid cell (`style.css:2425`)
- ITU, CQ, locator, lighthouse, notes, DOK, and the nr-sent/nr-rcvd inputs got `autocomplete="off"` to stop browser autofill from prefilling stale values. Doubles as the answer to the "ITU/CQ auto-filled with wrong zones" report: there is no zone lookup in the codebase; the values came from the browser's form memory
- Submit handler now rejects mismatched frequency/band combinations: `qso.freqBandMismatch` when the typed frequency belongs to a known band other than the selected one, `qso.freqNoBand` when it falls outside every amateur band. The existing auto-snap on freq input keeps doing its job, so most users never see the error
- Tab order through the QSO form now refreshes when the layout changes — `applyQSOLayout()` runs from the `contest_updated` WS handler whenever `qso_layout` or `custom_fields` is in the payload, so dragging fields and saving immediately rewrites `tabIndex` on the live form
- Enter pressed inside the Band or Mode `<select>` submits the form (browsers swallow Enter inside `<select>` natively). A new keydown listener on `#qso-form` calls `requestSubmit()`; all other Enter handling stays untouched

### Contest configuration reuse
- New "Duplicate" pill on every contest tile (`POST /api/contests/:id/copy`): clones custom fields, QSO-mask layout, log columns, band list, NR padding, stash expiry and station defaults into a fresh empty contest. Permissions mirror the create flow (`contests.manage` for public, `create_private` for private) plus read access to the source. `Store.DuplicateContest()` lives in `internal/store/contests.go`
- Cross-operator share-via-link workflow (`internal/server/shares.go`, `internal/store/shares.go`). New `contest_shares` table (token PK, contest_id, owner_user_id, source_name, frozen JSON payload, created_at) backs 22-char URL-safe tokens from `crypto/rand`. Endpoints: `POST/GET/DELETE /api/contests/:id/shares[/{tok}]` for the owner side, public `GET /api/share/:token` for previews (returns payload summary — custom-field count, layout tiles, bands — so importers can inspect before committing), and `POST /api/import-share` to materialise a snapshot into a new contest. Station identity (callsign/QTH/station_id) is intentionally not in the payload — importer brings their own
- A 🔗 pill on each contest tile opens `contestShareModal()` with the existing share links (copy-URL and revoke actions) plus a "Create share link" button. The contest picker gains "Import shared config" next to "+ New Contest" in both card and list views; `showContestScreen()` auto-detects `?share=TOKEN` in the page URL, strips the query and pre-fills the import dialog
- `DeleteContest` cascades into `DeleteSharesForContest` so revoking a contest doesn't leave dangling tokens
- All visible strings localised in EN and informal-du DE

### Settings-save preservation
- `/api/settings` PUT now decodes every field as `*string` / `*int` / `*bool`. `nil` = "field absent → preserve current"; non-nil = "client sent this, apply it". The handler starts `ns` from `s.settings` and overlays only the fields actually present in the request body
- Resolves a class of silent data-loss bugs caused by three forms (`#global-settings-form`, `#settings-form`, `#ms-settings-form`) sharing one endpoint while each managing a different subset of fields. Saving Global Settings used to wipe `default_mode` / `default_band` — this is what the long-standing "defaults can't be saved" report was actually about. Saving Personal Settings used to wipe `cluster_server` / `chat_sound` / `public_feature_requests`. Any save could wipe the QRZ.com credentials
- Audit-log "details" line rebuilt with `appendDetail()` so it only mentions fields the request actually touched
- Client-side belt-and-braces: `showGlobalSettings()` and `loadSettings()` stash the loaded QRZ username; the submit handler only sends `qrz_username` when the input differs and `qrz_password` when the operator typed something. Works in tandem with the pointer-based server change

### Other UX polish
- Global Settings card got a top toolbar with the heading on the left and Back-to-contests + Save on the right. The top Save is a `<button type=submit form=global-settings-form>` so the existing submit handler does all the work; the action group wraps below the heading on narrow screens
- Sidebar nav labels renamed for clarity: operator-facing "My Requests" pill is now "Feature Requests"; the admin-only button is now "View all Feature Requests". EN + DE catalogs updated; templates already bound via `data-i18n` so no HTML edits needed
- `programVersion` bumped to `0.55`

## v0.54 — 2026-05-29 — Sortable columns on feature-request tables

- `#fr-table` and `#my-fr-table` headers gain `class="sortable"` + `data-sort-key`; the checkbox column and the trailing actions column in the admin table stay unsortable
- New per-table sort state objects (`frSort`, `myFrSort`) cycle through 3 states on repeated clicks of the same column: `asc → desc → unsorted`. Clicking a different column resets the cycle to `asc`
- New helpers in `app.js`:
  - `applySort(list, state)` — returns a new sorted array using a string/lex comparator (ISO date strings sort temporally too), or the original list when the state is empty
  - `paintSortArrows(tableId, state)` — appends/refreshes a `.sort-arrow` span (▲/▼) inside each `th.sortable` and toggles a `.sort-active` class for highlighting
  - `wireSortableTable(tableId, state, onChange)` — binds the click cycle and triggers a re-render
- `renderFeatureRequests()` and `renderMyFeatureRequests()` now run the list through `applySort` and call `paintSortArrows` so headers stay in sync with the current state
- If the "From" column is hidden in personal mode and the active sort is on `from`, the state is cleared on the next render so the user doesn't end up sorted on an invisible column
- CSS: added `#fr-table th.sortable`, `#my-fr-table th.sortable`, and matching `:hover` / `.sort-active` rules mirroring the existing audit/QSO table styling
- `programVersion` bumped to `0.54`

## v0.53 — 2026-05-29 — Public feature requests toggle

- New global setting `public_feature_requests` (bool, persisted in the `settings` key/value table) — exposed in the `/api/settings` GET/PUT payload alongside the other admin-only fields
- `Settings` struct in `internal/store/store.go` gains `PublicFeatureRequests bool`, loaded from / saved to the `public_feature_requests` row (`"1"` / `"0"`)
- `handleMyFeatureRequests` (`GET /api/feature-requests/mine`) now serves `ListFeatureRequests()` (the full list) when the toggle is on, and `ListFeatureRequestsByUser(sess.Username)` (only the caller's) when it is off — POST/PUT/DELETE behavior is unchanged, so the public view is strictly read-only
- New fieldset "Feature requests" in the global settings screen (admin-only) with a single checkbox bound to `gs-public-feature-requests`; the setting round-trips through `showGlobalSettings()` and the `global-settings-form` submit handler
- `renderMyFeatureRequests()` now reads `settings.public_feature_requests`: when true, the screen title switches to "Feature Requests", a "From" column is shown, and the empty-state copy changes; layout otherwise unchanged, no edit/delete controls are rendered in either mode
- `refreshMyFeatureRequests()` calls `loadSettings()` first so the rendering mode reflects the current server-side toggle, even if the admin flipped it after another user logged in
- New i18n keys: `globalSettings.featureRequestsTitle`, `globalSettings.featureRequestsHint`, `globalSettings.publicFeatureRequests`, `featureRequests.publicTitle`, `featureRequests.noPublicRequests` (EN + DE)
- `programVersion` bumped to `0.53`

## v0.52 — 2026-05-29 — Telegram notifier catches up on multiple unposted versions

- `runPost` in `cmd/notify-telegram/main.go` now walks back from the newest CHANGELOG entry to `last_posted_version` and posts each missing entry as a separate message in chronological order (oldest first), with a 1.5 s sleep between messages to stay under Telegram's ~1 msg/sec per-chat rate limit
- New helper `entriesToPost(entries, lastPosted, force) []entry` does the slice selection. Empty `last_posted_version` (first run after `--setup`) and unknown `last_posted_version` (the recorded version is no longer in the array — e.g. the entry was edited or you switched branches) both fall back to posting only the top entry so the bot can never spam 50 historical messages by accident
- `last_posted_version` is persisted after every successful `sendMessage`, not just at the end of the batch — so a network failure mid-catch-up (e.g. v0.52 succeeds, v0.53 fails) resumes from v0.53 on the next deploy instead of replaying v0.52
- `--force` still reposts only the top entry (the intent of `--force` is "the latest, again"), and `--version X.Y` still posts a specific entry without touching `last_posted_version`
- `--dry-run` now shows every message that would be posted, numbered `[i/N] vX.Y — date`, instead of just the top one
- `programVersion` bumped to `0.52`

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
