#!/usr/bin/env node
/**
 * End-to-end self-test for the edit-set applier.
 *
 *   node scripts/selftest.mjs
 *
 * Builds a throwaway fixture under `.fixtures/`, drives `apply-edits.mjs`
 * through create + append-section + --write + --revert as a child process, and
 * asserts the files, the adoption record (signature and baseline), and the
 * EXPERIENCE.md line at each step. It also pins the signature rule: an `add`
 * set without one is refused, a `prune` set without one is accepted.
 *
 * Every artifact the test creates is removed afterwards, including the adoption
 * record and backup, so repeated runs leave the lab unchanged. Exits non-zero
 * with `FAIL` on the first broken assertion.
 */
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { paths, readJson, readText, writeText } from './lib/lab.mjs'
import { loadDigests } from './lib/measure.mjs'

const ID = 'selftest-p0'
const SIGNATURE = 'edit:FsError/FS_NOT_OBSERVED'
const APPLIER = join(paths.root, 'scripts', 'apply-edits.mjs')
const FIXTURES = join(paths.root, '.fixtures')
const FIXTURE = join(FIXTURES, 'selftest')
const PROJECT = join(FIXTURE, 'project')
const SET_DIR = join(FIXTURE, 'proposals')

const ORIGINAL = '# Fixture project\n\nKeep it small.\n\n## Verification\n\nRun the check.\n'
const SKILL_BODY = '---\nname: selftest-skill\ndescription: created by the applier self-test\n---\nBody.\n'
const APPENDED = 'Reopen every artifact you wrote.'

const skillFile = join(PROJECT, '.dsh', 'skills', 'selftest-skill', 'SKILL.md')
const agentsFile = join(PROJECT, 'AGENTS.md')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Run the applier in a child process; `expect: null` accepts any exit status. */
function apply(args, { expect = 0 } = {}) {
  const result = spawnSync(process.execPath, [APPLIER, ...args], { cwd: paths.root, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (expect !== null && result.status !== expect) {
    throw new Error(`apply-edits ${args.join(' ')} exited ${result.status}\n${output}`)
  }
  return { status: result.status, output }
}

/** Remove everything the run may have created, in the lab and the fixture. */
async function clean() {
  await rm(join(paths.adoptions, `${ID}.json`), { force: true })
  await rm(join(paths.adoptions, `${ID}-unsigned.json`), { force: true })
  await rm(join(paths.backups, ID), { recursive: true, force: true })
  const experience = await readText(paths.experience)
  if (experience && experience.includes(`\`${ID}\``)) {
    await writeText(paths.experience, experience.split('\n').filter((line) => !line.includes(`\`${ID}\``)).join('\n'))
  }
  await rm(FIXTURE, { recursive: true, force: true })
  await rmdir(FIXTURES).catch(() => {}) // only when no other fixture lives there
}

function editSet(overrides = {}) {
  return {
    id: ID,
    scope: 'project',
    kind: 'add',
    class: 'procedure',
    target: PROJECT,
    dimension: 'writeFailures',
    signature: SIGNATURE,
    evidence: ['selftest'],
    rationale: 'Self-test: create a skill, append a section, then revert.',
    edits: [
      { op: 'create', file: '.dsh/skills/selftest-skill/SKILL.md', content: SKILL_BODY },
      { op: 'append-section', file: 'AGENTS.md', section: 'Verification', content: APPENDED },
    ],
    ...overrides,
  }
}

async function main() {
  await clean()

  const digests = await loadDigests(paths.digests)
  assert(digests.length > 0, 'digests/ is empty — run `node scripts/digest.mjs` before the selftest')

  await mkdir(PROJECT, { recursive: true })
  await mkdir(SET_DIR, { recursive: true })
  await writeText(agentsFile, ORIGINAL)

  const setPath = join(SET_DIR, 'p0.edits.json')
  await writeText(setPath, `${JSON.stringify(editSet(), null, 2)}\n`)

  // 1. Apply.
  apply(['--set', setPath, '--write'])

  const agentsAfter = await readText(agentsFile)
  assert(agentsAfter?.startsWith('# Fixture project'), 'AGENTS.md lost its original content')
  assert(agentsAfter.includes(APPENDED), 'AGENTS.md did not receive the appended section')
  assert((await readText(skillFile)) === SKILL_BODY, 'the created skill does not match the edit set')

  // 2. The record is what a later measurement needs.
  const record = await readJson(join(paths.adoptions, `${ID}.json`), null)
  assert(record, 'the adoption record was not written')
  assert(record.signature === SIGNATURE, `adoption signature is ${JSON.stringify(record.signature)}`)
  assert(record.baseline && typeof record.baseline === 'object', 'adoption baseline is null')
  assert(record.baseline.sessions > 0, `baseline has no sessions (${JSON.stringify(record.baseline)})`)
  assert(record.baseline.hits > 0, `baseline has no hits (${JSON.stringify(record.baseline)})`)
  assert(record.files.length === 2, `adoption recorded ${record.files.length} files, expected 2`)
  assert(record.revertedAt === null, 'a fresh adoption is already marked reverted')

  const experience = await readText(paths.experience)
  assert(experience?.includes(`signature \`${SIGNATURE}\``), 'the EXPERIENCE.md line omits the signature')
  assert(experience.includes(ID), 'the EXPERIENCE.md line omits the adoption id')

  // 3. The signature rule: required for `add`, optional for `prune`.
  const unsignedPath = join(SET_DIR, 'unsigned.edits.json')
  const unsigned = editSet({ id: `${ID}-unsigned`, signature: undefined })
  await writeText(unsignedPath, JSON.stringify(unsigned, null, 2))
  const refused = apply(['--set', unsignedPath], { expect: null })
  assert(refused.status !== 0, 'an `add` set without a signature was accepted')
  assert(/signature/i.test(refused.output), 'the refusal does not mention the signature')

  const prunePath = join(SET_DIR, 'prune.edits.json')
  const prune = {
    id: `${ID}-prune`,
    scope: 'project',
    kind: 'prune',
    target: PROJECT,
    edits: [{ op: 'delete', file: '.dsh/skills/selftest-skill/SKILL.md' }],
  }
  await writeText(prunePath, JSON.stringify(prune, null, 2))
  apply(['--set', prunePath]) // dry run only: a `prune` set may omit the signature

  // 4. Revert restores the byte-for-byte original and removes what was created.
  apply(['--revert', ID])
  assert((await readText(agentsFile)) === ORIGINAL, 'revert did not restore AGENTS.md byte for byte')
  assert((await readText(skillFile)) === null, 'revert left the created file behind')
  const directoryGone = await lstat(join(PROJECT, '.dsh', 'skills', 'selftest-skill')).then(
    () => false,
    () => true,
  )
  assert(directoryGone, 'revert left the created directory behind')
  const reverted = await readJson(join(paths.adoptions, `${ID}.json`), null)
  assert(reverted?.revertedAt, 'the adoption record is not marked reverted')

  return `PASS  ${ID}  create + append-section → write → revert; signature ${SIGNATURE}, baseline ${record.baseline.sessions} session(s) / ${record.baseline.hits} hit(s)`
}

let summary
try {
  summary = await main()
} catch (error) {
  await clean().catch(() => {})
  console.error(`FAIL  ${error.message}`)
  process.exit(1)
}
await clean()
console.log(summary)
