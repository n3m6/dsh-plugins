# DSH adoption of `security-audit`

Upstream: <https://github.com/cloudflare/security-audit-skill> (MIT), taken at
commit `c1c8a8c` (`Clarify guidance and full audit modes`, 2026-09-14) and vendored
here as ordinary files, tracked by `n3m6/dsh-plugins`. There is no nested clone and
no upstream remote in this repository.

The skill itself is used unchanged. The adoption adds a Harness adapter and a
pointer to it, because one capability the workflow depends on is missing here.

## What is local

| Path | Change |
|---|---|
| `skills/security-audit/DSH.md` | New. Maps the skill's platform terms to Harness tools, records the missing sandbox, sets the source-only execution policy, and gives Harness-specific output-directory and validation commands. |
| `skills/security-audit/SKILL.md` | Two lines under "Platform terminology" pointing at `DSH.md`. No upstream rule was edited. |
| `ADOPTION.md` | This file. |

Everything else — the six-phase workflow, companions, `report-schema.json`,
validators, tests — is upstream and unmodified.

## Why the adapter

`SKILL.md` requires any target-controlled code to run inside an OS-enforced sandbox
with network isolation, an allowlisted empty environment, resource limits, and
scratch-only writes. The Harness Bash executor provides file confinement only:
network stays open, the environment is inherited, and spawned processes are not
limited; `danger-full-access` provides no confinement at all. A run here is
therefore source-only, and every behavioural lead becomes `needs_validation` with
the missing sandbox as its blocker. The skill already defines that degradation path,
so the adapter routes into it rather than weakening the evidence bar.

## Install

Discovery needs the bundle at a scanned root. This machine uses `$AGENTS_HOME/skills`,
the same root `harness-lab` installs into:

```bash
ln -s /home/n3m6/dsh-plugins/security-audit-skill/skills/security-audit \
      ~/.agents/skills/security-audit
```

The symlink keeps this directory as the only copy, so editing `DSH.md` changes what
the next session loads. DSH rescans the root, so no restart is needed; the skill
appears in the catalog as `security-audit` with the upstream description.
Uninstall is the symlink plus this directory, removed in a commit.

## Update

Updates are a reviewed copy, not a merge:

```bash
git clone --depth 1 https://github.com/cloudflare/security-audit-skill /tmp/sa
diff -r /tmp/sa/skills/security-audit skills/security-audit   # review first
```

Copy the changed upstream files over, then keep the two local changes from the
table above: `DSH.md` is untouched by upstream and survives, and `SKILL.md` needs
the "On DeepSeek Harness" paragraph re-added in "Platform terminology". Run the
tests, update the commit hash in this file, and commit in `dsh-plugins`.

## Verify

```bash
# vendored copy intact: expect 65 passing tests
cd skills/security-audit && node --test validate-findings.test.cjs validate-coverage-ledger.test.cjs

# validators run against a real run directory
node skills/security-audit/validate-coverage-ledger.cjs ~/security-audit-skill/<repo>/run-1/coverage-ledger.json
node skills/security-audit/validate-findings.cjs        ~/security-audit-skill/<repo>/run-1/findings.json

# discovery: a fresh session's catalog lists security-audit, and loading it
# returns DSH.md's heading as a linked resource
```

## Use

Ask for a security question or review and the skill loads in guidance mode. Ask to
audit or pen-test a codebase, or for report artifacts, and it runs the full
six-phase workflow. On this machine the default output directory is
`~/security-audit-skill/<repo-name>/run-<N>`, writable because the file policy is
`danger-full-access`.
