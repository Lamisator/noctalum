# Noctalum — Claude Instructions

## Committing

After every change, create a git commit. Do not batch multiple unrelated changes into one commit. Each logical change gets its own commit.

## Versioning & Changelog

Every code change MUST:
1. Increment the version number in `/workspace/internal/server/web/i18n.js` under the key `changelog.version` (format: `0.1`, `0.2`, `0.3`, etc.)
2. Add a new entry at the **top** of `/workspace/CHANGELOG.md` with the new version, a brief English description of the change
3. Add the same entry to the in-app changelog data in `/workspace/internal/server/web/app.js` (the `CHANGELOG` array — newest entry first), with both `en` and `de` text

The version number starts at `0.1` and increments by `0.1` for each change. After `0.9` comes `0.10`, then `0.11`, etc. — it never rolls over to `1.0`.

## Localization

Every user-facing text string must be localized in **both English (EN) and German (DE)** via `/workspace/internal/server/web/i18n.js`. Never hardcode English text in HTML or JavaScript — always add a key to the `en` and `de` catalogs and reference it with `data-i18n` (HTML) or `t('key')` (JS).

In German translations, always use the informal **"du"** form (e.g. "Wähle", "Erstelle", "dein", "dich") — never the formal "Sie"/"Ihnen"/"Ihr" form.
