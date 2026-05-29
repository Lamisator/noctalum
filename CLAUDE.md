# Noctalum — Claude Instructions

## Committing

After every change, create a git commit. Do not batch multiple unrelated changes into one commit. Each logical change gets its own commit.

Commit messages MUST be comprehensive: they should explain *what* changed and *why* in enough detail that the message stands on its own as the durable record for the release notes. Prefer a short imperative subject line, followed by a blank line and a body that covers:
- the user-facing behavior change (what an operator notices)
- the files / functions touched and the mechanism
- any non-obvious trade-offs, edge cases, or follow-ups

These bodies are what `/release` reads when it builds the changelog entry, so terse `fix: typo` style messages are fine for genuine typos but should be the exception, not the norm.

## Versioning & Changelog

**Do not bump the version or touch the changelog on regular commits.** `programVersion`, `CHANGELOG.md`, and the `CHANGELOG` array in `internal/server/web/app.js` are only updated by the `/release` skill — see `.claude/commands/release.md`.

The Telegram deploy notifier (`cmd/notify-telegram`) keys off the `CHANGELOG` array, so commits without a release entry are silently rolled into the next release announcement instead of generating their own message.

The version number starts at `0.1` and increments by `0.1` per release. After `0.9` comes `0.10`, then `0.11`, etc. — it never rolls over to `1.0`.

## Localization

Every user-facing text string must be localized in **both English (EN) and German (DE)** via `/workspace/internal/server/web/i18n.js`. Never hardcode English text in HTML or JavaScript — always add a key to the `en` and `de` catalogs and reference it with `data-i18n` (HTML) or `t('key')` (JS).

In German translations, always use the informal **"du"** form (e.g. "Wähle", "Erstelle", "dein", "dich") — never the formal "Sie"/"Ihnen"/"Ihr" form.
