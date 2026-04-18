# Linter Reverse-Engineering Notes

## Confirmed from live runtime

- The client sends full annotation payloads to:
  - `POST /api/trpc/transcriptions.lintAnnotations?batch=1`
- Lint messages come back from this API response as row-linked items:
  - shape: `{ annotationId, reason, severity }`
- Example observed response message:
  - `Extra spaces at the end or beginning of segments are not allowed.`

## Confirmed from downloaded app chunk

- In `4252-36aad0f832a67f54.js`, the transcription page keeps an internal rule key list:
  - `empty-content`
  - `multiple-asterisks`
  - `unpaired-asterisks`
  - `empty-emphasis`
  - `punctuation-in-emphasis`
  - `bracket-validation`
  - `style-tag-validation`
  - `curly-bracket-validation`
  - `double-spaces`
  - `leading-trailing-spaces`
  - `overlapping-segments`
  - `distance-between-annotations`
  - `triple-dash`
  - `spaced-double-dash`
  - `double-dash-punctuation`
  - `double-dash-outside-quote-or-tag`
  - `double-dash-missing-space`
  - `unresolved-low-confidence`
- The same chunk also contains language-specific tag dictionaries and per-language enabled linter sets.

## Babel-owned native lint issues captured in this repo

This repo does contain evidence of Babel's own lint rules. The most concrete native rule inventory currently documented here is the internal rule key list above, which appears to be Babel-owned rather than helper-added:

- `empty-content`
- `multiple-asterisks`
- `unpaired-asterisks`
- `empty-emphasis`
- `punctuation-in-emphasis`
- `bracket-validation`
- `style-tag-validation`
- `curly-bracket-validation`
- `double-spaces`
- `leading-trailing-spaces`
- `overlapping-segments`
- `distance-between-annotations`
- `triple-dash`
- `spaced-double-dash`
- `double-dash-punctuation`
- `double-dash-outside-quote-or-tag`
- `double-dash-missing-space`
- `unresolved-low-confidence`

Observed native issue text currently captured in repo:

- `Extra spaces at the end or beginning of segments are not allowed.`

What this means:

- The repo has a native Babel rule inventory by internal key.
- The repo does not currently contain a full exported catalog mapping every native rule key to its final user-facing message text.
- The repo does not currently contain Babel's server implementation for those rules, only reverse-engineered evidence that the client knows about them and that `lintAnnotations` returns issue objects.

## Helper-added lint issues in this repo

These are extension-owned and should not be confused with Babel-native rules:

- `Commas must be formatted as ", "`
- `Double quotes must be balanced.`
- `Double quotes must not have stray spaces inside or be glued to surrounding words.`
- `Curly tags must be formatted as "TEXT {TAG: OTHER}".`

Source of helper-added issues:

- `src/content/linter-bridge.ts`

Practical distinction:

- If an issue is emitted by the helper bridge rules above, it is helper-added.
- If an issue corresponds to the internal rule-key inventory above or comes back from Babel's `lintAnnotations` response before helper augmentation, it is Babel-owned/native.

## Native Babel autofix coverage in the helper

The helper can now conservatively auto-fix a small subset of Babel-native issues where the intended rewrite is low-risk:

- `leading-trailing-spaces`
  - implemented as trimming leading and trailing spaces/tabs from a row
- `double-spaces`
  - implemented as collapsing repeated in-line spaces between non-space characters

Deliberately not auto-fixed at this stage:

- structural/content rules such as `empty-content`, `overlapping-segments`, `distance-between-annotations`
- syntax/tag rules such as `bracket-validation`, `style-tag-validation`, `curly-bracket-validation`
- ambiguous punctuation rules such as the various double-dash rules

Reason:

- the repo only gives us partial reverse-engineered evidence for Babel-native rules
- several native rules are not safe to rewrite blindly without stronger live-runtime verification or server-side semantics

## Practical conclusion

- Babel's native linting is hybrid:
  - local client config (rule keys + language dictionaries)
  - server-side lint evaluation (`lintAnnotations`)
- Adding new native Babel rules without server changes is not realistic from an extension.
- The extension can safely add **helper-side custom rules** on top of native linting.

## Extension implementation added

- New feature module:
  - `src/features/custom-linter-feature.ts`
- New page bridge:
  - `src/content/linter-bridge.ts`
- New setting:
  - `customLinter` in `src/core/settings.ts`
- Feature wiring:
  - `src/features/index.ts`

Current helper-side rules:
- comma formatting: enforce `, ` (comma + single space)

Rule injection path:
- patch page `fetch` for `transcriptions.lintAnnotations`
- append helper issues to native payload entries with shape `{ annotationId, reason, severity }`

