# Harness Lab

A personal, human-gated loop that improves **skills and AGENTS.md** from the
friction already recorded in your session logs. No plugin, no install, no preset
changes. Every edit is a file edit with a backup and a revert.

Design and rationale: [SPEC.md](SPEC.md).

## Quick start

Every command goes through one dispatcher, so it runs from any directory:

```bash
LAB=/home/n3m6/dsh-plugins/harness-lab
HL="$LAB/scripts/harness.mjs"

node "$HL" digest                          # what recurs, across every project
node "$HL" digest --project ~/work/x       # what recurs in one project
node "$HL" evidence --signature <key>      # what happens around each occurrence
node "$HL" apply --set "$LAB"/proposals/<id>.edits.json           # dry run
node "$HL" apply --set "$LAB"/proposals/<id>.edits.json --write   # apply
node "$HL" apply --revert <id>                                    # undo
node "$HL" reject <signature> --reason "why"                      # silence it for 90 days
node "$HL" watch                           # did the edit work?
node "$HL" status                          # one screen: adoptions, rejections, drift
node "$HL" selftest                        # check the lab itself
```

`node "$HL" --help` lists the commands. Node 24 is enough — no dependencies.

## Install the skill

The skill is what makes a future session run the loop; without it the lab is a
pile of scripts you have to remember. Install it once:

```bash
node scripts/install.mjs --check      # what it sees: code root, frontmatter, target
node scripts/install.mjs --install    # symlink into $AGENTS_HOME/skills
node scripts/install.mjs --uninstall  # remove only what it created
```

It resolves the skill root as `$AGENTS_HOME/skills`, falling back to
`~/.agents/skills`, prefers a symlink so the checkout stays the single copy of
the truth, and falls back to a marked copy where symlinks are refused.

Installation is not discovery. DSH's filesystem provider scans project roots
first, then `$DSH_HOME/skills` and `$AGENTS_HOME/skills`; confirm with the skill
list in a fresh session's first prompt.

## Cadence

| When | Command | Scope |
|---|---|---|
| Weekly, Monday | `node "$HL" digest` then review candidates | every project, 3-project bar |
| After a bad session | `node "$HL" digest --project <dir>` | one project, 2-session bar |
| After any apply | `node "$HL" watch` | resolves open adoptions |
| Monthly | `node "$HL" audit` (not implemented yet) | prune / promote / demote |

A week with nothing to propose is a normal outcome: the run records
`verdict: quiet` and the loop stays silent.

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
5. **Watch** — `watch.mjs` compares the signature's rate over sessions that
   started after the adoption with the baseline frozen at apply time, and
   rewrites the EXPERIENCE line to `kept`, `reverted`, or `inconclusive` once the
   window closes (10 later sessions or 14 days).

A review that finds nothing is a success and records `verdict: quiet`.

## Files

| Path | What |
|---|---|
| `SPEC.md` | the design, including the parts that are still guesses |
| `skills/harness-improve/SKILL.md` | the agent-facing instructions; `install.mjs` makes it discoverable everywhere |
| `scripts/harness.mjs` | the dispatcher every command goes through; works from any cwd |
| `scripts/install.mjs` | check, install, or remove the skill symlink under `$AGENTS_HOME/skills` |
| `scripts/digest.mjs` | session logs → metrics, moments, signatures |
| `scripts/apply-edits.mjs` | validate → diff → backup → apply → revert, plus `--reject` / `--unreject` |
| `scripts/evidence.mjs` | the calls around every occurrence of a signature, plus an aggregate over all of them |
| `scripts/watch.mjs` | re-measures each adoption and resolves it |
| `scripts/status.mjs` | adoptions, active rejections, and drift, in one report |
| `scripts/selftest.mjs` | eleven end-to-end cases in a throwaway lab; never touches your records |
| `scripts/lib/` | session parsing, metrics, clustering, diffing, rate measurement |
| `scripts/lib/measure.mjs` | the definition of "the rate", its before/after comparison, and the verdict band |
| `proposals/` | edit sets you are considering |
| `adoptions/` | applied sets with before/after hashes — the audit trail |
| `backups/<id>/` | the previous content of every touched file |
| `runs/` | one record per digest, including quiet ones |
| `rejections.json` | signatures you turned down, with a cooldown |
| `EXPERIENCE.md` | append-only log of what was tried and what happened |

An edit set of kind `add`, `promote`, or `demote` names the friction `signature`
it targets (`prune`, `compress`, and `move` sets may omit it), and
`apply-edits.mjs` freezes that signature's rate over `digests/` into
`adoptions/<id>.json` as `baseline` — `{corpusSessions, sessions, hits,
hitsPerSession, sessionsPerHit}`. The judged number is `hitsPerSession`: hits
divided by every session in the corpus, so it falls when the friction stops and
also when sessions stop happening at all. With no digests yet the baseline is
`null`, never zero: "not measured" and "measured as absent" must stay
distinguishable.

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
- **State can move.** `HARNESS_LAB_DIR` points the same scripts at another lab
  directory. The self-test uses it to run against a throwaway lab, which is why
  it passes on a fresh clone instead of depending on `digests/` being populated.
- **One entry point, no cwd.** `scripts/harness.mjs` dispatches to the per-command
  scripts by absolute path, so a review runs from any directory. That is why the
  skill sets `LAB` and `HL` once and uses them everywhere.
- **A verdict needs a window.** `watch.mjs` refuses to judge an adoption before
  10 later sessions or 14 days, because a rate over two sessions is noise.
  `inconclusive` is provisional and re-judged; `kept` and `reverted` are final.
