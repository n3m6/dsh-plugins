# Harness Lab — design spec

Self-improving personal profile. Editable surface: **skills + AGENTS.md**.
Nothing here installs a package or changes a preset. Every edit is a file edit.

Status: Rung 0 implemented and exercised — `scripts/digest.mjs`,
`scripts/apply-edits.mjs`, and the `harness-improve` skill. See [README.md](README.md).
No package installed, no preset changed, nothing applied outside the lab.

## 1. What the two decisions imply

- **Personal profile, not a product.** One user is the approval channel and the
  label. No benchmark suite, no automated adoption, no UI. Optimize for the
  recurring friction in *your* sessions, not for a leaderboard.
- **Skills + AGENTS.md.** The harness has no enforcement layer. It is advice.
  That caps the ceiling (see §5) and it is the reason this design is safe: the
  editable surface is prose and Markdown, it cannot loosen the sandbox, change
  permissions, or install code.

The biggest consequence of the surface choice: **the harness is cwd-relative
files, so a probe needs no preset and no installation.** See §3.

## 2. Where the harness actually lives (verified against the installed packages)

Skill roots, highest rank first (`dsh-skill-filesystem`):

| Rank | Path | Discovered from |
|---|---|---|
| `project-dsh` | `<projectRoot>/.dsh/skills` | session cwd |
| `project-agents` | `<projectRoot>/.agents/skills` | session cwd |
| `custom` | any `customSkillDirs` | preset config |
| `user-dsh` | `$DSH_HOME/skills` | process env |
| `user-agents` | `$AGENTS_HOME/skills` | process env |

`projectRoot` is found by walking up from the session cwd to a root marker
(`.git` by default). Higher rank wins on a name collision.

Instructions (`dsh-agent-instructions`): `AGENTS.md` / `CLAUDE.md` per
directory, discovered upward, **additive** (they do not shadow), plus a
user-global `$DSH_HOME/AGENTS.md`. The standard preset caps the rendered
baseline at 65536 bytes.

Current state on this machine:

- `~/.agents/skills/` — 11 skills, all HyperFrames. A domain library, not a
  work-style harness.
- `~/.dsh/AGENTS.md` — **does not exist**.
- `~/.dsh/skills/` — **does not exist**.
- 22 project session corpora under `~/.dsh/sessions/`.

So the global invariant layer is empty today. That is the largest cheap win
available and the natural first target (§16).

## 3. The enabling fact: files are cwd-relative, so A/B needs no plugin

Because skill roots are resolved from the session cwd, two directories can carry
two different harnesses under one process, one preset, and one installation.

```
arms/<id>/
  AGENTS.md          # the arm's project instructions
  .dsh/skills/**     # the arm's project skills
  <project files>    # a git worktree, or a copy when the dir is not a repo
```

A probe is a `spawn` subagent whose `cwd` is the arm directory
(`subagents.startActivation({ cwd, prompt })`). It discovers that arm's harness
and nothing else from the project layer.

Collisions resolve in our favor: project roots outrank user roots, so an arm can
shadow `~/.agents/skills/<name>` by shipping `<arm>/.dsh/skills/<name>`.

## 4. What can and cannot be A/B tested

| Layer | Path | Changed by | Validated by |
|---|---|---|---|
| Domain skills | `<proj>/.dsh/skills/**` | edit in arm | **A/B** across two arms |
| Domain instructions | `<proj>/AGENTS.md` | edit in arm | **A/B** across two arms |
| Global skills | `~/.agents/skills/**` | edit in place | **replay** across ≥3 projects |
| Global instructions | `~/.dsh/AGENTS.md` | edit in place | **replay** across ≥3 projects |

The global layer cannot be A/B tested by cwd shadowing: `$DSH_HOME` and
`$AGENTS_HOME` come from the process environment and the instruction loader is
additive, so a global file cannot be made absent for one arm. Global changes are
therefore validated by replay, not by contrast. Say so in the proposal rather
than faking a controlled experiment.

## 5. Lever ceiling — read this before trusting the loop

Skills and AGENTS.md are *soft* levers. They work when the failure is "did not
know how" and they fail when the failure is "knew and did it anyway" or "was not
allowed to". If a friction signature survives two edit rounds, the answer is not
a third paragraph. The next rung up is a `tools/pre-execute` guard plugin, which
is explicitly **out of scope** for this design.

Classify every proposal before writing it:

- **Knowledge gap** → skill. Best fit for this surface.
- **Procedure gap** → AGENTS.md section. Fits.
- **Ignored invariant** → do not write more prose. Record it, escalate to the
  guard rung later.
- **Capability gap** → not addressable here. Drop it.

## 6. Signals

Deterministic digest from the session log
(`~/.dsh/sessions/<cwd>/session-*/session.jsonl.zstd`, records of
`{type, seq, time, data}`; decompress with zstd, or read via
`ctx.sessionQuery.observeSession`). The session header carries `cwd`,
`agentPreset`, `delegationDepth`.

Per session, compute a **vector**, not a scalar:

| Metric | Source | Meaning |
|---|---|---|
| `steps` | count `step/start` | length of the attempt |
| `turns` | count `turn/end` | user round-trips |
| `toolCalls` | count `tool/call` | volume, by tool name |
| `toolErrors` | count `tool/result` with `data.error` | failed actions |
| `repeatRate` | consecutive identical `(name, arguments)` | loops |
| `retryRate` | same tool name re-called after an error | flailing |
| `compactions` | count `compaction/*` | context pressure |
| `clarifications` | `ask_user_question` calls | avoidable questions |
| `approvals` | approval events | permission friction |
| `presented` | `present` called | deliverable handed over |
| `writeFailures` | `edit`/`write` results with `error` | read-before-write churn |
| `skillInvocations` | `tool/call` `name=skill`, keyed by skill | firing rate, feeds §11 |
| `tokens` | `ctx.tokenMeter.measure(session)` | cost |
| `wallMs` | `turn/end.time − turn/start.time` | latency |

Explicitly **no composite score.** A weighted sum invites optimizing the weight.
Each proposal names the one dimension it targets, and adoption requires that
dimension to improve without another regressing beyond a floor.

A **friction moment** is one step that produced an error, a repeat, or a
compaction, stored with ±1 step of context. Moments, not whole transcripts, are
what the improver reads. That is the context-economy decision in this design:
a 6370-record session reduces to ~200 tokens of signature.

## 7. Cadence

Two triggers, one engine. Both digest the same way; they differ in scope,
evidence bar, and what they are allowed to propose.

| | **Weekly sweep** | **On demand, per project** |
|---|---|---|
| Trigger | `schedule` reminder, Monday | you ask, usually after a bad session |
| Corpus | all 22 project roots | one project root |
| Looks for | cross-project signatures | project-local signatures |
| May propose | global edits + project edits | project edits only |
| Evidence bar | same signature in **≥3 distinct projects** | **≥2 sessions** in that project |
| Output cap | 1 global + 3 project | 1 |
| Runtime | minutes | seconds |

The bars differ because blast radius differs. A wrong project skill costs one
repo and one revert; a wrong global rule follows you into every repo and is
harder to notice.

**Silence is a valid outcome, and it must be recorded.** Every review writes
`runs/<id>.json` with `digested: N` and `verdict: quiet | proposed`. Otherwise a
quiet week and a broken loop look identical. Silence only means something if
digestion ran — so the review reports the count of sessions read even when it
proposes nothing.

## 8. Proposal lifecycle

A proposal is a diff plus evidence plus a claim. It is not applied until you say
so, and it is not forgotten until it is resolved.

```
pending ──approve──► adopted ──window──► kept | reverted | inconclusive
   │
   ├──reject──► rejected ──90 days──► eligible again
   └──newer proposal on same signature──► superseded
```

- **Rejection is durable.** `rejections.json` keys a signature to a date and a
  one-line reason. A rejected signature is not re-proposed for 90 days, or
  immediately if its rate doubles — new evidence reopens it, annoyance does not.
  Without this ledger, "stays quiet when nothing recurs" fails the moment a
  signature *does* recur.
- **One open proposal per signature.** A second review finding the same thing
  reports "already pending" rather than minting a duplicate.
- **Every adoption leaves a record and a backup**, not a commit in the target
  repo: the target is an ordinary checkout, and committing there would pollute
  your history. `adoptions/<id>.json` carries before/after hashes and the
  evidence; `backups/<id>/` holds the previous content; `--revert` restores.
- **Outcome tracking.** An adoption is judged only after its signature has been
  observed for the watch window — 10 sessions that started after the adoption, or
  14 days, whichever comes later — because a rate over two sessions is noise.
  The judged number is `hitsPerSession` over the later corpus, compared with the
  baseline frozen at apply time: `kept` when it fell at all, `reverted` when it
  rose by more than 25%, `inconclusive` inside that band. Two outcomes are
  provisional by design: `inconclusive` is re-judged as the corpus grows, and a
  null baseline can only ever be inconclusive. Both write back to
  `EXPERIENCE.md`. A failure that is recorded is worth more than a success that
  is assumed.

## 9. Loop A — hindsight (default)

Cheap, no probes, no isolation. This is the loop that runs forever.

1. **Digest.** For each session in the window, emit
   `digests/<session>.json`: header, metric vector, top-3 friction moments.
2. **Cluster.** Group moments by signature = (tool name, error class, adjacent
   skill/AGENTS.md section that was loaded). Apply the §7 evidence bar and the
   §8 cooldown.
3. **Propose.** At most the cap in §7, each classified per §5, each citing the
   sessions that support it, each naming one dimension, and each grounded in
   `scripts/evidence.mjs` rather than in the digest's three-moment sample.
4. **Approve.** You read diffs. Nothing is applied without a yes.
5. **Apply.** Write the files, commit, append to `EXPERIENCE.md`.
6. **Watch.** Track the signature for N sessions; `kept` or `reverted`.

## 10. Loop B — probe (on demand, for risky or unclear edits)

Only when Loop A's proposal is large, ambiguous, or touches a highly-used skill.

1. **Arms.** Base arm = current files. Candidate arm = base + one edit set. Both
   materialized as `git worktree add` (or a copy for non-repos).
2. **Run.** Same task on both, `spawn` subagent with `cwd` = arm. Sequential by
   default; parallel only when the budget allows.
3. **Compare.** Metric vectors. The candidate must win on its named dimension
   and not regress the others.
4. **Adopt or discard.** Record the pairing and the outcome either way.

Caveat to carry into the design: two independent runs of an open-ended task
differ for reasons unrelated to the harness. A single pair is weak evidence. Use
Loop B to *falsify* a proposal that Loop A already supports, not to discover one.

## 11. Monthly rebalancing (prune, promote, demote)

Monthly is a **layer rebalancing pass**, not a deletion pass. Recurrence drives
additions; only this pass moves material between layers or removes it. It runs on
a calendar, independent of whether any signature recurred — otherwise a quiet
month would also be a month without pruning.

**Firing rate** is the metric this needs, and it is derivable: `tool/call` with
`name=skill` records the skill id. So `skillInvocations` gives per-skill firing
over the window, per project and globally.

**When the corpus records no `skill` invocations at all, prune and demote are
suppressed.** A tool that was never called is not evidence that every skill is
dead, and a report that flags all of them is worse than a report that says
nothing. The audit names the condition in its notes instead. This was not a
hypothesis: the first real corpus (46 sessions) contains zero `skill` calls.

### Prune
A skill is a prune candidate when all hold: not invoked in 90 days; created more
than 60 days ago; not referenced by another skill or an AGENTS.md section — and
the corpus recorded at least one `skill` invocation, per the suppression rule
above.

Pruning **archives, never deletes**: move to `archive/skills/<name>/`, keep the
entry in `index.json` with `state: archived`. Restore is a move back. Pruning is
also the only class that removes capability, so it never auto-applies, regardless
of signal.

AGENTS.md cannot be pruned section-by-section — a section has no firing rate and
no individual attribution. So the monthly AGENTS.md pass is **compression**: merge
duplicates, drop anything the evidence no longer supports, and report the byte
count against the 65536 cap. You see the diff; nothing is dropped silently.

### Promote
The observable form — and the one the audit reports — is **the same skill name
under two or more project roots**. That is what "rewritten per project" looks
like on disk. The report distinguishes *byte-identical copies* (promote one as
is) from *variants* (merge first), because a promotion that picks one of three
diverged copies silently drops the other two.

Universality is still a judgment, not a rule: the body must be procedure rather
than fact.

Operable universality test: strip the repo-specific nouns — paths, package names,
service names, domain identifiers. If what remains is still a complete, usable
procedure, it can promote. If stripping leaves a hole, the missing part was a
fact about one codebase and it belongs in that project's AGENTS.md.

**Promotion is one edit set, not two.** It creates the global skill *and* deletes
the project copy atomically, because project roots shadow user roots — leave the
local copy in place and the promotion never takes effect in the one repo that
motivated it.

### Demote
Symmetric to promote: a global skill invoked in exactly one project across 90
days is a candidate to move down into that project. This is what keeps the global
layer honest as your work shifts. Same rule: one edit set, both sides.

## 12. Layout

```
harness-lab/
  SPEC.md
  index.json                 # id → scope, path, state (active|archived), adopted-at
  digests/<session>.json
  proposals/<id>.edits.json
  runs/<run-id>.json         # digested count, verdict, metrics, pairing verdict
  rejections.json            # signature → date, reason
  arms/<id>/                 # materialized probe arms (gitignored)
  archive/skills/<name>/     # pruned skills, restorable
  EXPERIENCE.md              # append-only: what was tried, what happened
```

`EXPERIENCE.md` is the improvement library. It is prose because you are the only
reader and the corpus is small enough to read. No retrieval index needed at this
scale; add one only if the file passes ~200 entries.

## 13. Edit-set schema

```json
{
  "id": "h-2026-10-21-a",
  "scope": "project",
  "kind": "add",
  "target": "/home/n3m6/work/auth-service",
  "class": "knowledge",
  "dimension": "repeatRate",
  "signature": "edit:FsError/FS_NOT_OBSERVED",
  "evidence": ["session-69603055", "session-1ea35fee"],
  "rationale": "Two sessions re-derived the same mapping by reading four files.",
  "edits": [
    { "op": "create", "file": ".dsh/skills/reconcile-sources/SKILL.md",
      "contentFile": "h-2026-10-21-a/skill.md" },
    { "op": "append-section", "file": "AGENTS.md",
      "section": "Verification", "content": "Reopen any artifact you wrote." }
  ]
}
```

JSON rather than YAML so the applier runs with no dependencies; `contentFile`
is resolved beside the edit set and keeps long bodies readable instead of
escaped inside a string. Edits apply in order, so several may target one file.

`signature` is the friction key the proposal addresses, written exactly as the
digest clusters it (`tool:ErrorClass`, `repeat:tool`, or `compaction`). It is
required when `kind` is `add`, `promote`, or `demote`, and may be omitted for
`prune`, `compress`, and `move`-only sets. The applier validates it, records it
in `adoptions/<id>.json`, and freezes that signature's rate over the current
`digests/` as `baseline: {sessions, hits, sessionsPerHit}` — or `null` when no
digests exist yet — so the adoption can be measured after the watch window.

Allowed ops: `create`, `append-section`, `replace-section`, `delete`, `move`.
Allowed files: `AGENTS.md`, `.dsh/skills/**`, `.agents/skills/**`,
`$DSH_HOME/AGENTS.md`, and `archive/**` for prune. Anything else is rejected by
the applier, not by the prompt.

A promotion edit set carries both sides and fails as a unit:

```yaml
kind: promote
edits:
  - {op: create, file: ~/.agents/skills/reconcile-sources/SKILL.md, content: ...}
  - {op: delete, file: <proj>/.dsh/skills/reconcile-sources/SKILL.md}
```

## 14. Safety and budgets

- **Path allowlist enforced in code** (the applier), not in the instruction.
- **No deletions** outside a skill directory; no touching `.git`, `settings.yaml`,
  `.credentials.yaml`, or `profiles/`.
- **AGENTS.md budget.** The loader caps at 65536 bytes. The applier must report
  current size and refuse an append that exceeds it. A good improver is allowed
  to *compress* AGENTS.md as an edit — that is a legitimate proposal class.
- **Global layer is never auto-applied**, even with a strong signal.
- **Prune never auto-applies** and only ever archives.
- **One adoption record and one backup per apply**, restorable with `--revert`.
- **Max 3 proposals per review; max 1 probe pair per proposal.**
- **Cost cap** per review, from `tokenMeter`.

## 15. Implementation ladder

| Rung | What | Needs install? | Why this order |
|---|---|---|---|
| 0 | `harness-improve` skill + `digest.mjs` + `apply-edits.mjs` | no | tests whether the signal is real |
| 1 | weekly `schedule` reminder invoking Rung 0 | no | removes the discipline requirement |
| 2 | Host plugin: digest on turn end, `harness_review` / `harness_apply` tools | yes | convenience, not capability |
| 3 | probe runner with worktree arms | yes | only after Rung 0 shows separation |
| 4 | guard-plugin surface | yes | out of scope; see §5 |

Rung 0 is a script plus a skill. It answers the only question that matters
before any of the rest is worth building: **do the metrics actually separate good
sessions from bad ones on your work?** If they do not, a plugin makes a faster
version of a useless signal.

## 16. First move, concretely

The global layer is empty: no `~/.dsh/AGENTS.md`, no user-level work skills.
Meanwhile there are 22 project corpora on disk. So the first review is not a
tuning exercise, it is a bootstrap:

1. Digest all 22 corpora.
2. Rank signatures by (frequency × projects affected), not by severity.
3. Draft **one** `~/.dsh/AGENTS.md`, under ~2KB, covering only signatures seen in
   ≥3 projects. Anything project-specific belongs in that project's AGENTS.md.
4. Show the diff and the evidence; adopt on approval.
5. Re-digest after two weeks and keep or revert.

A 2KB global file written from real evidence beats a 40KB file written from
imagination, and it is the only version that can be falsified.

## 17. Decisions

Settled:

- **Window** — weekly sweep *and* per-project on demand; scope and evidence bars
  in §7.
- **Silence** — allowed, and recorded as `verdict: quiet` with a digest count.
- **Deletion** — monthly rebalancing pass: prune by firing rate, archive rather
  than delete, never automatic (§11).
- **Cross-project reuse** — promotion on demonstrated universality: signature in
  ≥3 projects and a body that survives stripping repo-specific nouns; atomic
  create-plus-delete (§11).

Still open:

- **Watch window N** — how many sessions before an adopted edit is judged kept
  or reverted? Needs to be long enough to see the signature again, short enough
  to still be attributable. Starting guess: 10 sessions or 14 days, whichever
  comes later.
- **Numeric floors** — the 90-day prune window, 60-day age floor, 3-project
  promotion bar, and 90-day rejection cooldown are all guesses. They should be
  tuned from the first three months of `runs/`.
- **On-demand scoping** — does "per project" mean the project you are in, or a
  named one? Default to the current session's project root.
