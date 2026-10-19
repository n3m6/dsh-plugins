# Compaction Threshold

A local DSH bundle that makes the context-compaction trigger a user setting
instead of a fixed fraction of the model window.

- **Default:** 300,000 tokens.
- **Where to change it:** Settings → General → **Context compaction**.
- **Options:** 100k, 150k, 200k, 250k, 300k, 400k, 500k, 650k.
- **Indicator:** a small ring in the composer dock shows progress toward the
  trigger. Hovering gives the short reading and trigger share; clicking opens a
  breakdown panel with the same system/tools/messages composition the context
  meter uses, plus remaining tokens, trigger, window, and share.
- **Scope:** the preference is profile-wide and live for every session whose
  preset revision mounted the backend after this bundle was installed.

## Why two plugins

The Web profile disables its top-level `compaction-basic`; each session's agent
preset mounts its own backend inside an isolated `compaction` realm. A global
preference therefore needs two halves:

1. `index.js` — a profile entry with a **volatile** `thresholdTokens` Config
   field. It provides `ctx.compactionThreshold`, whose getter reads the live
   Config reference. Volatile fields are committed in place without remounting,
   so a Settings write is visible immediately.
2. `backend.js` — extends the shipped `BasicCompactionEngine`. On each pressure
   check it reads the preference and the routed model's context window, then
   supplies the engine with `thresholdRatio = tokens / window` and a retention
   budget no larger than half the trigger. Overflow recovery, `/compact`,
   pruning, summarization, replay and the log bracket all stay in the shipped
   engine.

`client.js` adds the General-settings row and the composer-dock indicator. Both
read the same form store; the row writes through
`ctx.configForms.get('compaction-threshold-settings')`, the same Host-settings
transport every other preference uses.

## The preset override

`cordis.patch.yml` overrides the shipped `preset-standard` declaration. The
override restates the complete shipped `config.plugins` list, swapping only the
`compaction-basic` row for `@local/dsh-compaction-threshold/backend`; the rest is
byte-for-byte the installed preset at authoring time.

This is the supported way to change a shipped preset, but it **pins** the
Standard preset to the DSH release it was copied from. After a DSH upgrade:

```bash
node regenerate-patch.mjs
```

then reinstall the bundle or toggle it off/on. Existing sessions keep their
preset revision; start a new session to use an updated preset.

## Files

| File | Role |
|---|---|
| `index.js` | Profile entry, volatile Config, `compactionThreshold` service |
| `backend.js` | Preset-mounted engine subclass |
| `client.js` | General-settings row and composer-dock indicator |
| `cordis.patch.yml` | Bundle patch: settings entry + Standard preset override |
| `regenerate-patch.mjs` | Rebuild the preset override from the installed Standard preset |
| `locale/*.json`, `icon.svg` | Plugin Manager metadata |

## Verification limits

Installation, the active settings entry, and both live Client slot
registrations (`settings.general.item` and `conversation.composer.dock`) were
verified through Host/Client Inspect. The indicator's render logic was exercised
with mocked projections for the closed, hover, panel, waiting, and over-trigger
states. The rendered ring/tooltip/panel, a live settings write, and the 300k
trigger in a long session were not exercised end-to-end here; start a new
session and watch for `compaction (step pressure)` in the Host log, or use
`/compact`.
