# Harness Lab

A personal, human-gated loop that improves **skills and AGENTS.md** from the
friction already recorded in your session logs. No plugin, no install, no preset
changes. Every edit is a file edit with a backup and a revert.

Design and rationale: [SPEC.md](SPEC.md).

## Quick start

```bash
node scripts/digest.mjs                       # what recurs, across every project
node scripts/digest.mjs --project ~/work/x    # what recurs in one project
node scripts/apply-edits.mjs --set proposals/<id>.edits.json           # dry run
node scripts/apply-edits.mjs --set proposals/<id>.edits.json --write   # apply
node scripts/apply-edits.mjs --revert <id>                            # undo
```

Node 24 is enough — the scripts use `node:zlib` zstd support and no dependencies.

## How the loop runs

1. **Digest** — decompress every `session.jsonl.zstd`, compute a metric vector
   per session (steps, tool errors, repeat rate, compactions, skill invocations,
   tokens), and extract the three worst friction moments.
2. **Cluster** — group moments into signatures like
   `write:FsError/FS_NOT_OBSERVED`. Reach decides: 3 projects for a global
   proposal, 2 sessions for a project one.
3. **Propose** — at most three edit sets, each naming one metric dimension and
   citing real sessions.
4. **Approve** — you read the diff. Nothing is written before that.
5. **Track** — `kept` or `reverted` once the signature has been observed for the
   watch window.

A review that finds nothing is a success and records `verdict: quiet`.

## Files

| Path | What |
|---|---|
| `SPEC.md` | the design, including the parts that are still guesses |
| `skills/harness-improve/SKILL.md` | the agent-facing instructions; symlink into `~/.agents/skills/` to make it discoverable everywhere |
| `scripts/digest.mjs` | session logs → metrics, moments, signatures |
| `scripts/apply-edits.mjs` | validate → diff → backup → apply → revert |
| `scripts/lib/` | session parsing, metrics, clustering, diffing |
| `proposals/` | edit sets you are considering |
| `adoptions/` | applied sets with before/after hashes — the audit trail |
| `backups/<id>/` | the previous content of every touched file |
| `runs/` | one record per digest, including quiet ones |
| `rejections.json` | signatures you turned down, with a cooldown |
| `EXPERIENCE.md` | append-only log of what was tried and what happened |

## Design notes worth knowing before you extend it

- **No composite score.** The vector is deliberately a set of independent
  counters; a weighted sum only tells you which weight to climb. Proposals name
  their dimension.
- **Backups, not commits, in the target repo.** Targets are ordinary project
  checkouts and `~/.dsh`; committing there would pollute your history. The
  audit trail lives in `adoptions/` and `backups/`, and `--revert` restores.
- **The path allowlist is code, not prompt.** `apply-edits.mjs` refuses anything
  outside `AGENTS.md`, `.dsh/skills/**`, `.agents/skills/**`, `~/.dsh/AGENTS.md`,
  and `archive/**`, and refuses symlinks and the credential files.
- **Writes outside the workspace need approval.** The global layer lives in
  `~/.dsh` and `~/.agents`, so `--write` there will hit the sandbox. That is the
  human gate doing its job, not a bug.
- **Silence needs a heartbeat.** Every run writes `runs/<id>.json` with a
  digested count, so "nothing recurred" is distinguishable from "the loop did
  not run".
