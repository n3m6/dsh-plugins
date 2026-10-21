# Working notes

## Reading before editing

The filesystem observation policy records only reads made with the `read` tool.
Inspecting a file with `cat`, `sed`, `head`, or `grep` through bash does not
count as an observation, so the following `edit` or `write` fails with
`FS_NOT_OBSERVED` and costs a round trip.

Read a file with `read` before editing it. Use bash for directory listings, git,
and commands — not for looking at file contents you are about to change.
