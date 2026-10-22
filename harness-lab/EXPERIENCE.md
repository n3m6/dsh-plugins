# Experience

Append-only record of what the harness lab tried and what happened. Each entry
names the proposal, its dimension, and whether it was kept or reverted.
- 2026-10-21 · `h-2026-10-21-a` · add · global · dimension `toolErrors` · signature `edit:FsError/FS_NOT_OBSERVED` · 1 file(s) · **kept** (1.27 → 0.54 hits/session) — Of 124 FS_NOT_OBSERVED edit/write failures across the corpus, 122 were preceded by a bash command touching the same filename and 0 by a read-tool call [corrected at review: 121/124 bash-touched, 2 read-touched — the zero was a `path` vs `file_path` artifact]: the model inspects with cat/sed and then edits. The existing rule says 'read before editing' but not that a bash read does not satisfy the policy.
