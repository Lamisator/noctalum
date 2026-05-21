# Noctalum — Claude Instructions

## Committing

After every change, create a git commit. Do not batch multiple unrelated changes into one commit. Each logical change gets its own commit.

## Localization

Every user-facing text string must be localized in **both English (EN) and German (DE)** via `/workspace/internal/server/web/i18n.js`. Never hardcode English text in HTML or JavaScript — always add a key to the `en` and `de` catalogs and reference it with `data-i18n` (HTML) or `t('key')` (JS).
