# Adoption of `security-audit`

Upstream: <https://github.com/cloudflare/security-audit-skill> (MIT), taken at
commit `c1c8a8c` (`Clarify guidance and full audit modes`, 2026-09-14) and vendored
here as ordinary files, tracked by `n3m6/dsh-plugins`. There is no nested clone and
no upstream remote in this repository.

The skill itself is used unchanged. The adoption adds harness adapters and pointers
to them, because one capability the workflow depends on is missing on each harness.

## What is local

| Path | Change |
|---|---|
| `skills/security-audit/DSH.md` | New. Maps the skill's platform terms to Harness tools, records the missing sandbox, sets the source-only execution policy, and gives Harness-specific output-directory and validation commands. |
| `skills/security-audit/OPENCODE.md` | New. Maps the skill's platform terms to OpenCode's `subagent` tool and built-in `explore`/`general` agents, records the missing sandbox, and sets the source-only execution policy, write-isolation rules, output-directory guidance, and validation commands. |
| `skills/security-audit/SKILL.md` | Two paragraphs under "Platform terminology" pointing at `DSH.md` and `OPENCODE.md`. No upstream rule was edited. |
| `ADOPTION.md` | This file. |

Everything else — the six-phase workflow, companions, `report-schema.json`,
validators, tests — is upstream and unmodified.

## Why the adapters

`SKILL.md` requires any target-controlled code to run inside an OS-enforced sandbox
with network isolation, an allowlisted empty environment, resource limits, and
scratch-only writes. Neither harness supplies one:

- **DeepSeek Harness** confines file writes only. Network stays open, the environment
  is inherited, and spawned processes are not limited; `danger-full-access` provides
  no confinement at all.
- **OpenCode** runs `shell` with the host user's filesystem, process, and network
  authority. Permission rules gate whether a command starts, not what it reaches.
  Subagents use their own agent permissions, and the `subagent` tool has no per-call
  permission or working-directory parameter.

A run on either harness is therefore source-only, and every behavioural lead becomes
`needs_validation` with the missing sandbox as its blocker. The skill already defines
that degradation path, so the adapters route into it rather than weakening the
evidence bar.

## Install

Discovery needs the bundle at a scanned root. This machine uses two roots, both
pointing at this directory so there is only one copy:

```bash
# DeepSeek Harness
ln -s /home/n3m6/dsh-plugins/security-audit-skill/skills/security-audit \
      ~/.agents/skills/security-audit

# OpenCode native global root
ln -s ../../../dsh-plugins/security-audit-skill/skills/security-audit \
      ~/.config/opencode/skills/security-audit
```

OpenCode also reads `~/.agents/skills`, but the native `~/.config/opencode/skills`
source has higher precedence. Adding the native link makes the OpenCode adoption
explicit and keeps the loaded definition independent of the compatibility path.

DSH rescans the root, and a fresh OpenCode session discovers the native root, so a
new session sees the skill as `security-audit` with the upstream description. Uninstall is the two
symlinks plus this directory, removed in a commit.

## Update

Updates are a reviewed copy, not a merge:

```bash
git clone --depth 1 https://github.com/cloudflare/security-audit-skill /tmp/sa
diff -r /tmp/sa/skills/security-audit skills/security-audit   # review first
```

Copy the changed upstream files over, then keep the local changes from the table
above: `DSH.md` and `OPENCODE.md` are untouched by upstream and survive, and
`SKILL.md` needs both "On DeepSeek Harness" and "On OpenCode" paragraphs re-added
under "Platform terminology". Run the tests, update the commit hash in this file,
and commit in `dsh-plugins`.

## Verify

```bash
# vendored copy intact: expect 65 passing tests
cd skills/security-audit && node --test validate-findings.test.cjs validate-coverage-ledger.test.cjs

# validators run against a real run directory
node skills/security-audit/validate-coverage-ledger.cjs ~/security-audit-skill/<repo>/run-1/coverage-ledger.json
node skills/security-audit/validate-findings.cjs        ~/security-audit-skill/<repo>/run-1/findings.json

# discovery: a fresh session's catalog lists security-audit, and loading it
# exposes the matching adapter (DSH.md or OPENCODE.md) as a linked resource
```

## Use

Ask for a security question or review and the skill loads in guidance mode. Ask to
audit or pen-test a codebase, or for report artifacts, and it runs the full
six-phase workflow.

- **DeepSeek Harness**: the default output directory is
  `~/security-audit-skill/<repo-name>/run-<N>`, writable because the file policy is
  `danger-full-access`.
- **OpenCode**: the same default applies; OpenCode's default `external_directory`
  policy allows the write. Load the skill by asking for a security audit or with
  `@security-audit`.
