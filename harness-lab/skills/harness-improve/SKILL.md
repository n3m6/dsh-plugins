---
name: harness-improve
description: Run a harness review over past sessions when the user asks to improve the harness, review recurring friction, prune unused skills, or promote a fix to the global layer. Digests session logs into friction signatures, proposes at most three bounded edits to skills or AGENTS.md, and applies only what the user approves.
---

# Harness improve

The harness here is **skills and AGENTS.md only**. Nothing in this skill installs
a package, edits a preset, or changes permissions. Every change is a file edit
that can be reverted.

## Run a review

```bash
node scripts/digest.mjs                      # weekly sweep: all projects, 3-project bar
node scripts/digest.mjs --project ~/work/x   # on demand: one project, 2-session bar
node scripts/digest.mjs --since 90 --json    # wider window, machine-readable
```

The digest writes one file per session plus a signature cluster, and prints the
signatures that clear the bar. **Read the printed output only** — do not open
`signatures.json` or the digests unless a candidate needs more evidence.

A candidate signature is `tool:ErrorClass` (a failure), `repeat:tool` (a loop),
or `compaction` (context pressure). The bar is reach, not severity:

| Scope | Bar | May propose |
|---|---|---|
| weekly sweep | same signature in ≥3 projects | global and project edits |
| per project | ≥2 sessions in that project | project edits only |

**No candidate is a valid result.** Say so and stop. Do not invent work to have
something to report.

## Decide before proposing

Read the candidate's sample moments. Classify it:

- **Knowledge gap** — did not know how. → a skill.
- **Procedure gap** — knew how, skipped a step. → an AGENTS.md section.
- **Ignored invariant** — knew and did it anyway, repeatedly. → **do not write
  more prose.** Report it as belonging to the guard layer and stop.
- **Capability gap** — the tool or the access was missing. → not addressable
  here. Report and stop.

If a signature has already survived two edit rounds, it is an ignored invariant
whatever it looks like. Escalate instead of editing.

## Propose

At most **three** edit sets per review. Each one names exactly one metric
dimension and cites real session ids. Write the proposal to
`proposals/<id>.edits.json`:

```json
{
  "id": "h-2026-10-21-a",
  "scope": "project",
  "kind": "add",
  "target": "/home/me/work/auth-service",
  "class": "knowledge",
  "dimension": "repeatRate",
  "evidence": ["session-69603055", "session-1ea35fee"],
  "rationale": "Two sessions re-derived the same schema mapping by reading four files.",
  "edits": [
    {
      "op": "create",
      "file": ".dsh/skills/reconcile-sources/SKILL.md",
      "contentFile": "h-2026-10-21-a/skill.md"
    }
  ]
}
```

`contentFile` is resolved next to the edit set and is the readable way to ship a
whole file. Put large bodies there, not in a JSON string.

Ops: `create`, `replace`, `append-section` (needs `section`), `replace-section`,
`delete`, `move` (needs `to`). Allowed files are `AGENTS.md`,
`.dsh/skills/**`, `.agents/skills/**`, `~/.dsh/AGENTS.md` — and nothing else. The
applier enforces this; a rejected path is a bug in the proposal, not a prompt
failure.

## Preview, then apply

```bash
node scripts/apply-edits.mjs --set proposals/h-2026-10-21-a.edits.json
```

Dry run is the default and prints a diff. **Show that diff to the user and wait.**
Apply only after they approve:

```bash
node scripts/apply-edits.mjs --set proposals/h-2026-10-21-a.edits.json --write
node scripts/apply-edits.mjs --revert h-2026-10-21-a     # if it was a mistake
```

If `--write` fails with a permission error, the target is outside the writable
workspace. Ask for the escalation; do not try another path.

## Monthly rebalancing

Once a month, instead of (or in addition to) the sweep:

- **Prune** — a skill with no `skillInvocations` in 90 days, older than 60 days,
  not referenced elsewhere. `move` it to `archive/skills/<name>/`, never delete.
  Prune always needs explicit approval.
- **Promote** — a project skill whose signature appears in ≥3 projects and whose
  body still reads as a complete procedure after stripping repo nouns (paths,
  package names, service names). One edit set: create global **and** delete the
  project copy. Leaving the local copy means it shadows the global one and the
  promotion does nothing.
- **Demote** — the reverse: a global skill invoked in exactly one project for 90
  days moves down into that project.
- **Compress** — AGENTS.md cannot be pruned section by section, so the monthly
  pass merges duplicates and reports the byte count against the 65536 budget.

## Non-negotiables

- One dimension per proposal. Never a composite score.
- Evidence is session ids that exist. Never cite a signature you did not digest.
- The global layer (`~/.dsh/AGENTS.md`, `~/.agents/skills/**`) is never applied
  without the user explicitly approving that specific diff.
- A rejected signature stays silent for 90 days. Record it in
  `rejections.json`; do not re-propose it next week.
- After applying, record `kept` or `reverted` in `EXPERIENCE.md` once the
  signature has been observed for the watch window (10 sessions or 14 days).
