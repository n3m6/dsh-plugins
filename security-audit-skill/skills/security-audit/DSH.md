# DeepSeek Harness adapter

Read this after `SKILL.md` and before Phase 1. The other files remain the single
source of truth; this file only maps platform terms to Harness mechanics and states
which controls the Harness cannot supply. Where this file and an upstream file
disagree about how to call a tool, this file wins; otherwise upstream wins.

## Capability check before full audit mode

| What the workflow needs | On DeepSeek Harness |
|---|---|
| A parent that owns shared state | Yes — this session. |
| Fresh, context-isolated delegated agents | Yes — the `subagent` tool starts a child that does not see this conversation. |
| Parallel delegation | Yes — several `subagent` calls in one message, or one `workflow` script. |
| OS-enforced sandbox for target-controlled code | **No.** See below. |
| Zero-dependency validators | Yes — `node` is on `PATH`; both validators import only `node:*`. |
| Reusable skill resources | Yes — this directory. Resolve every `X.md` link against it. |

The Harness Bash executor confines file writes only. Network access stays
unrestricted, the target process inherits the environment instead of an allowlist,
and no CPU, memory, file-size, or disk limit applies to what a command spawns. The
per-command timeout and output caps are guards on the agent, not confinement of the
target, and a background job has no deadline at all. With `danger-full-access` there
is no confinement of any kind.

Because of that, a run on the Harness is source-only. Write `execution_policy:
"source-only"` in `run-metadata.json` (not the upstream
`sandboxed-source-and-local-only`), and add why:

```json
"execution_capability": {
  "sandbox": "unavailable",
  "missing": ["network isolation", "empty allowlisted environment",
              "resource and wall-clock limits", "scratch-only write confinement"]
}
```

Never execute target-controlled code to promote a candidate. A lead whose decisive
fact needs execution stays `needs_validation` with the blocker
`sandbox: no OS-enforced execution sandbox available` and a plan the owner can run
outside the Harness. If the user explicitly supplies a sandbox launcher that meets
every control in `SKILL.md`, the user's command runs, its exact command and limits
go in `run-metadata.json`, and its output is promoted only through the procedure in
`SKILL.md`. With approvals disabled nothing is approved implicitly: an unnamed
launcher is not authorized, and the parent never builds one itself.

If `node` is missing, Phases 4 and 5 cannot pass. Record the missing runtime as the
incomplete reason instead of skipping validation.

## Delegation mapping

| Upstream term | Harness mechanism |
|---|---|
| Task tool | `subagent`, one child per call. For a wave, use `workflow` with `agent()` / `parallel()` / `pipeline()`. |
| `research` agent | `subagent` whose prompt carries the `research` role preamble. The Harness has no agent types; the role lives in the prompt. |
| `general` agent | `subagent` whose prompt carries the `general` role preamble. |
| "Launch verifiers in parallel" | Several `subagent` calls in one assistant message, or `parallel()` in a workflow script. |
| One agent invocation | One `subagent` call or one `agent()` call. Count them this way for the budget. |
| Structured result returned through the Task tool | The child's final message. Require exactly one JSON object, no prose wrapper, and reject what does not parse. |

Rules that follow:

- Every child prompt is self-contained. The child sees none of this conversation,
  the ledger in your context, or your conclusions. Give absolute paths to the run
  directory and copy the required blocks verbatim; never write "as discussed above".
- Never use `subagent_fork` for a hunter, critic, or verifier. It seeds the child
  with this conversation and destroys the independence the workflow rests on.
- Do not reuse a finished child. A verification round needs a fresh agent even when
  the follow-up is small.
- A child that fails or returns malformed JSON closed nothing: leave the unit
  `planned` or the candidate unvalidated. `workflow` resolves a failed child to
  `null`; filter those out instead of reading them as empty results.
- Set each child's `cwd` to its `scratch/` root and require absolute paths for every
  read, so relative writes land where they belong. This is hygiene, not a boundary.

## Write isolation

The parent alone writes `run-metadata.json`, `architecture.md`,
`coverage-ledger.json`, `findings.json`, and the Phase 6 reports. Re-read a shared
file with `read` before rewriting it with `edit` or `write`; the Harness rejects a
mutation it has not observed.

The Harness applies one file policy per session and the `subagent` tool exposes no
policy parameter, so a child cannot be given narrower access than the session's.
Isolation therefore binds children by instruction and by where you point them. Keep
the remaining work parent-side:

- name the child's single writable path in the prompt and declare everything else
  read-only by contract;
- run the promotion procedure in `SKILL.md` on every file a child produced before
  using it as evidence — a scratch tree is target-controlled output regardless of
  what the prompt said;
- never give a child `cwd` inside the run directory, the target, or a parent-owned
  `artifacts/` tree.

## Output directory

The default `~/security-audit-skill/<repo-name>/run-<N>` depends on the session's
file policy:

| Policy | What to do |
|---|---|
| `danger-full-access` | Use the default. |
| `workspace-write` | Writes are allowed only under the workspace root plus `/tmp`; `/tmp` is not a valid fallback for run state. If the target is a strict subdirectory, use a run directory in the workspace outside the target, such as `<workspace>/audits/<repo>/run-<N>`. If the workspace is the target, accept a directory inside the target only when the user explicitly asks for it and Git ignores the whole directory; otherwise stop and ask. |
| `read-only` | Nothing can be written anywhere. Say so, offer guidance mode, and do not start a full audit. |

Ask with `ask_user_question` when the choice changes the path: one question, the
concrete options, no preamble.

## Child prompt conventions

Include these in every delegated prompt:

- read source with `read`, discover with `grep` and `glob`, run commands with
  `bash`; do not inspect file contents with `cat`, `head`, or `sed`;
- no `web_search`, `web_fetch`, or `present`, and no network access of any kind;
- write only under the assigned `scratch/` path, and only when the task needs it;
- return one JSON object and nothing else.

## Parent workflow

- Open the run with `todo_write` carrying the six phases and update it as phases
  close.
- Validate after every ledger update and before any phase that depends on it:
  `node <skill-dir>/validate-coverage-ledger.cjs <output-dir>/coverage-ledger.json`
  and in Phases 4 and 5:
  `node <skill-dir>/validate-findings.cjs <output-dir>/findings.json`
  A nonzero exit fails the phase; it is not a warning.
- Keep the run's artifacts on disk. In chat report the source ref, profile, coverage
  statement, confirmed counts by severity, `needs_validation` count, and paths.
  Never paste a ledger or a report body into the conversation.
- `present` only the final `REPORT.md`, and only when the user asked to open it.
- Track phases in the todo list, not in chat narration: one line per phase result.

## What this adapter does not change

Severity calibration, the candidate gate, `needs_validation` discipline, coverage
and budget rules, the promotion procedure, target-neutral reporting, and every
schema requirement.
