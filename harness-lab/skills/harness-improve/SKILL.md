---
name: harness-improve
description: Run a harness review over past sessions when the user asks to improve the harness, review recurring friction, prune unused skills, or promote a fix to the global layer. Digests session logs into friction signatures, proposes at most three bounded edits to skills or AGENTS.md, and applies only what the user approves.
---

# Harness improve

The harness here is **skills and AGENTS.md only**. Nothing in this skill installs
a package, edits a preset, or changes permissions. Every change is a file edit
that can be reverted.

## Run a review

All commands go through one dispatcher, so they work from any directory:

```bash
LAB=/home/n3m6/dsh-plugins/harness-lab      # the checkout
HL="$LAB/scripts/harness.mjs"                # the dispatcher
```

If the checkout moves, update `LAB`; `node "$HL" --help` lists every command and
`install.mjs --check` prints the code root it resolves.

```bash
node "$HL" digest                      # weekly sweep: all projects, 3-project bar
node "$HL" digest --project ~/work/x   # on demand: one project, 2-session bar
node "$HL" digest --since 90 --json    # wider window, machine-readable
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

## Get evidence before proposing

A two-line sample from the digest is not enough to explain a signature. Read
what actually happened around every occurrence:

```bash
node "$HL" evidence --signature edit:FsError/FS_NOT_OBSERVED
node "$HL" evidence --signature repeat:bash --context 5 --limit 10
```

It prints the calls before each occurrence and an aggregate over all of them:
which tools touched the same file earlier, and what ran immediately before. The
`touched since last write` line is the one that usually explains the mechanism —
a call only counts after the last write, because a write ends the epoch.

Then classify:

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
  "signature": "edit:FsError/FS_NOT_OBSERVED",
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

`signature` is the signature key the digest clustered on, and it is required for
`add`, `promote`, and `demote` (a `prune`- or `compress`-only set has no single
signature to attribute). The applier records that signature's current rate as the
adoption's baseline, which is what makes the result measurable later.

`contentFile` is resolved next to the edit set and is the readable way to ship a
whole file. Put large bodies there, not in a JSON string.

Ops: `create`, `replace`, `append-section` (needs `section`), `replace-section`,
`delete`, `move` (needs `to`). Allowed files are `AGENTS.md`,
`.dsh/skills/**`, `.agents/skills/**`, `~/.dsh/AGENTS.md` — and nothing else. The
applier enforces this; a rejected path is a bug in the proposal, not a prompt
failure.

## Preview, then apply

```bash
node "$HL" apply --set "$LAB"/proposals/h-2026-10-21-a.edits.json
```

Dry run is the default and prints a diff. **Show that diff to the user and wait.**
Apply only after they approve:

```bash
node "$HL" apply --set "$LAB"/proposals/h-2026-10-21-a.edits.json --write
node "$HL" apply --revert h-2026-10-21-a     # if it was a mistake
```

If `--write` fails with a permission error, the target is outside the writable
workspace. Ask for the escalation; do not try another path.

## Close the loop

An applied edit is not a result. Two commands decide:

```bash
node "$HL" watch      # kept / reverted / inconclusive for every open adoption
node "$HL" status     # adoptions, active rejections, and drift
```

`watch.mjs` withholds a verdict until 10 sessions have started after the
adoption or 14 days have passed, then rewrites that adoption's EXPERIENCE line
in place. Run it at the start of every review, before proposing anything —
an adoption that came back `reverted` is the most useful evidence you have.

`status.mjs` always exits 0; read its **drift** section. Orphan EXPERIENCE
lines, a file edited after the lab wrote it, or an adoption with no digests all
mean the measurement is compromised, and none of them show up in the digest.

## When the user says no

```bash
node "$HL" reject <signature> --reason "one line why"
node "$HL" unreject <signature>   # to reopen it
```

A rejection silences that signature for 90 days in every later digest; without
it the loop re-proposes the same thing next week and silence stops meaning
anything.

## Monthly rebalancing

```bash
node scripts/harness.mjs audit            # the report
node scripts/harness.mjs audit --json     # machine-readable
node scripts/harness.mjs audit --strict   # exit 1 when anything is actionable
```

The audit is a report and never edits. It inventories every skill root, the
invocations recorded in the window, and the AGENTS.md sizes, then proposes:

- **promote** — the same skill name under two or more project roots. The report
  says whether the copies are byte-identical: identical copies promote cleanly,
  variants need a merge first. One edit set creates the global skill **and**
  deletes the project copies, or the local copy shadows it.
- **prune** — older than 60 days, no invocation in the window, referenced
  nowhere else. `move` it to `archive/skills/<name>/`; never delete.
- **demote** — a user-root skill invoked from exactly one project.
- **compress** — an AGENTS.md above 75% of the 65536-byte budget.

Prune and demote are suppressed when the corpus records no skill invocations at
all: with no signal every skill would look unused, and a report that says that
is worse than a report that says nothing. Read the `notes` block before proposing
anything — "no recorded invocation" is not "unused".

## Non-negotiables

- One dimension per proposal. Never a composite score.
- Evidence is session ids that exist. Never cite a signature you did not digest.
- The global layer (`~/.dsh/AGENTS.md`, `~/.agents/skills/**`) is never applied
  without the user explicitly approving that specific diff.
- A rejected signature stays silent for 90 days. Record it with `--reject`; do
  not re-propose it next week, and do not argue with a rejection unless the rate
  has doubled.
- Never hand-edit an EXPERIENCE line. `watch.mjs` owns the `**pending**` marker
  and rewrites it in place; editing it by hand makes the timeline lie.
