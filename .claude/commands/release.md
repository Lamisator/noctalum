Cut a new Noctalum release: bump the version, fold every commit since the previous release into a single changelog entry, and commit the release on its own.

Regular feature/fix commits do NOT bump the version or touch the changelog (per CLAUDE.md). `/release` is the only path that does both. Until `/release` runs, the Telegram deploy notifier has nothing to announce — it reads the `CHANGELOG` array in `app.js`, and that array only grows here.

## Inputs

Accepted optional arguments (pass them through verbatim if the user supplied any):
- `--version X.Y` — force a specific version number (skip the auto-increment).
- `--dry-run` — print the planned changelog entry but don't write files or commit.

If neither flag is given, pick the next version by reading the current `programVersion` in `internal/server/server.go` and adding `0.1` (after `0.9` comes `0.10`, then `0.11`, …; the number never rolls over to `1.0`).

## Steps

1. **Determine the previous release point.** The last `CHANGELOG` array entry in `internal/server/web/app.js` records the previous version. Use `git log v<prev>..HEAD --reverse --format=...` if a matching tag exists; otherwise fall back to:
   ```
   git log <commit-that-touched-app.js-CHANGELOG-array-last>..HEAD --reverse --format='%H%n%s%n%b%n--END--'
   ```
   The goal is to enumerate every commit landed *after* the previous release commit. If no previous release commit can be found (fresh repo), fall back to the last 20 commits.

2. **Read the commits.** Pull the full message body (subject + body) for each commit since the previous release. Bundle related commits into a single coherent release-note narrative — do NOT just concatenate subject lines. The body of each commit is the canonical source, so quote/summarize the substantive parts (mechanism, files, trade-offs) rather than re-deriving them by reading the diff.

3. **Decide the version.** Pick the next version per the rules above unless `--version X.Y` was supplied. Refuse if the supplied version already exists in `CHANGELOG.md` or the `CHANGELOG` array in `app.js`.

4. **Compose the release notes.** Each release entry is written in three places and must stay in sync:
   - `CHANGELOG.md` — add a new section at the very top in the existing format:
     ```
     ## v<version> — <YYYY-MM-DD> — <short release headline>

     - bullet 1
     - bullet 2
     - …
     - `programVersion` bumped to `<version>`
     ```
     Bullet points should be technical but readable: file/function references where they help, mechanism over diff, trade-offs noted. Cover every commit landed since the previous release — none should be silently dropped.
   - `internal/server/web/app.js` — prepend a new `{ version, date, en, de }` object to the `CHANGELOG` array (newest first). `en` and `de` are prose paragraphs (not bullet lists) aimed at the operator running the app. The German text uses the informal "du" form (per CLAUDE.md). They should convey the same substance as the `CHANGELOG.md` bullets but read like release-note copy, not a commit log.
   - `internal/server/server.go` — bump the `programVersion` constant to the new version.

5. **Show the user the proposed release before writing** (unless `--dry-run`). Print:
   - the chosen version,
   - the list of commits being folded in (one-line subjects),
   - the proposed `CHANGELOG.md` section,
   - the proposed EN and DE prose for the in-app changelog.
   Ask the user to confirm. On `--dry-run`, stop here without modifying any files.

6. **Apply the changes** and run a single commit:
   ```
   git add CHANGELOG.md internal/server/web/app.js internal/server/server.go
   git commit -m "release: v<version> — <short headline>"
   ```
   The commit message body should list the rolled-up commit subjects so the release commit is self-explanatory in `git log`. Do NOT amend or rewrite earlier commits.

7. **Do NOT push or deploy.** Just report success and the new version number. Pushing/deploying is a separate user action (see `/deploy`).

## Notes

- If the user has uncommitted local changes that aren't part of the release, refuse and ask them to commit or stash first — the release commit must contain only the three release-file edits.
- The Telegram notifier (`cmd/notify-telegram`) walks back from the newest changelog entry to its stored `last_posted_version` and posts every intervening entry, so adding exactly one entry per release produces exactly one Telegram announcement per release. Do not split a release into multiple consecutive `CHANGELOG` entries.
- Localization rule still applies to any user-facing strings added in the commits being released — but `/release` itself only writes prose paragraphs into the `CHANGELOG` array and the markdown file; it does not need to touch `i18n.js`.
