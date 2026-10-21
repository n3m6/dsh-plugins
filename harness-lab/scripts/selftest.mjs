#!/usr/bin/env node
/**
 * Self-test for the harness lab: applier, lifecycle, and the report surfaces.
 *
 *   node scripts/selftest.mjs
 *
 * Every case builds its own throwaway lab under `.fixtures/` and points the
 * scripts at it with `HARNESS_LAB_DIR`, so the test never reads the user's
 * digests, never writes their records, and passes on a fresh clone where
 * `digests/` is empty. The only thing it borrows from the real lab is the code.
 *
 * Prints `PASS` with a one-line summary, or `FAIL` with the broken assertion and
 * a non-zero exit. All fixtures are removed either way.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, rm, rmdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectCandidates } from './lib/signatures.mjs'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const CODE_ROOT = dirname(SCRIPTS)
const FIXTURES = join(CODE_ROOT, '.fixtures')
const RUN = join(FIXTURES, `run-${process.pid}`)

const SIGNATURE = 'edit:FsError/FS_NOT_OBSERVED'
const DAY = 86_400_000
const NOW = Date.parse('2026-11-01T00:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const HEADER = '# Experience\n\nAppend-only record of what the harness lab tried and what happened.\n'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function daysAgo(days) {
  return new Date(NOW - days * DAY).toISOString()
}

async function write(file, content) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function readJsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function exists(file) {
  return readFile(file).then(
    () => true,
    () => false,
  )
}

/** A minimal lab: empty digests, no adoptions, no rejections, empty journal. */
async function makeLab(name) {
  const dir = join(RUN, name)
  await mkdir(join(dir, 'digests'), { recursive: true })
  await mkdir(join(dir, 'adoptions'), { recursive: true })
  await write(join(dir, 'rejections.json'), '{}\n')
  await write(join(dir, 'EXPERIENCE.md'), HEADER)
  return dir
}

/** One digest with `hits` occurrences of an error signature. */
async function writeDigest(lab, { id, startedAt, hits, signature = SIGNATURE }) {
  const [tool, error] = signature.split(':')
  const moments = Array.from({ length: hits }, () => ({ kind: 'error', tool, error, step: 1, snippet: 'x' }))
  await write(join(lab, 'digests', `${id}.json`), JSON.stringify({ sessionId: id, startedAt, project: 'fixture', moments }))
}

async function writeAdoption(lab, { id, at, signature = SIGNATURE, baseline, files = [] }) {
  const record = { id, at, signature, baseline, files, revertedAt: null, set: { kind: 'add', scope: 'project' } }
  await write(join(lab, 'adoptions', `${id}.json`), JSON.stringify(record, null, 2))
}

async function appendExperience(lab, id, extra = '') {
  const text = await readFile(join(lab, 'EXPERIENCE.md'), 'utf8')
  const line = `- 2026-10-21 · \`${id}\` · add · project · dimension \`x\` · signature \`${SIGNATURE}\` · 1 file(s) · **pending** — fixture${extra}\n`
  await write(join(lab, 'EXPERIENCE.md'), `${text.trimEnd()}\n${line}`)
}

/** Run one lab script against a throwaway lab. */
function run(script, args, lab, { expect = 0 } = {}) {
  const result = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd: lab,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_LAB_DIR: lab },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (expect !== null && result.status !== expect) {
    throw new Error(`${script} ${args.join(' ')} exited ${result.status}\n${output}`)
  }
  return { status: result.status, output }
}

// ---------------------------------------------------------------- cases ----

async function caseApplier() {
  const lab = await makeLab('applier')
  for (const [index, hits] of [2, 1, 1, 0].entries()) {
    await writeDigest(lab, { id: `s${index}`, startedAt: daysAgo(20 - index), hits })
  }

  const project = join(lab, 'project')
  const original = '# Fixture project\n\nKeep it small.\n\n## Verification\n\nRun the check.\n'
  await write(join(project, 'AGENTS.md'), original)
  const skillBody = '---\nname: selftest-skill\ndescription: created by the applier self-test\n---\nBody.\n'
  const set = {
    id: 't-applier',
    scope: 'project',
    kind: 'add',
    class: 'procedure',
    target: project,
    dimension: 'writeFailures',
    signature: SIGNATURE,
    evidence: ['selftest'],
    rationale: 'Self-test: create + append, then revert.',
    edits: [
      { op: 'create', file: '.dsh/skills/selftest-skill/SKILL.md', content: skillBody },
      { op: 'append-section', file: 'AGENTS.md', section: 'Verification', content: 'Reopen it.' },
    ],
  }
  await write(join(lab, 'set.json'), JSON.stringify(set, null, 2))

  run('apply-edits.mjs', ['--set', join(lab, 'set.json'), '--write'], lab)

  const agents = await readFile(join(project, 'AGENTS.md'), 'utf8')
  assert(agents.includes('Reopen it.'), 'AGENTS.md did not receive the appended section')
  assert((await readFile(join(project, '.dsh/skills/selftest-skill/SKILL.md'), 'utf8')) === skillBody, 'skill not created')

  const record = await readJsonFile(join(lab, 'adoptions', 't-applier.json'))
  assert(record.signature === SIGNATURE, 'adoption lost the signature')
  assert(record.baseline?.corpusSessions === 4, `baseline corpus is ${record.baseline?.corpusSessions}, expected 4`)
  assert(record.baseline?.hits === 4, `baseline hits is ${record.baseline?.hits}, expected 4`)
  assert(record.baseline?.hitsPerSession === 1, `baseline rate is ${record.baseline?.hitsPerSession}, expected 1`)

  const experience = await readFile(join(lab, 'EXPERIENCE.md'), 'utf8')
  assert(experience.includes(`signature \`${SIGNATURE}\``), 'EXPERIENCE line omits the signature')

  // An `add` set must name a signature; a `prune` set may omit it.
  await write(join(lab, 'unsigned.json'), JSON.stringify({ ...set, id: 't-unsigned', signature: undefined }))
  const refused = run('apply-edits.mjs', ['--set', join(lab, 'unsigned.json')], lab, { expect: null })
  assert(refused.status !== 0 && /signature/i.test(refused.output), 'an add set without a signature was accepted')

  await write(
    join(lab, 'prune.json'),
    JSON.stringify({ id: 't-prune', scope: 'project', kind: 'prune', target: project, edits: [{ op: 'delete', file: '.dsh/skills/selftest-skill/SKILL.md' }] }),
  )
  run('apply-edits.mjs', ['--set', join(lab, 'prune.json')], lab)

  run('apply-edits.mjs', ['--revert', 't-applier'], lab)
  assert((await readFile(join(project, 'AGENTS.md'), 'utf8')) === original, 'revert did not restore AGENTS.md')
  assert(!(await exists(join(project, '.dsh/skills/selftest-skill'))), 'revert left the created skill behind')
}

async function caseRejection() {
  const lab = await makeLab('rejection')
  run('apply-edits.mjs', ['--reject', SIGNATURE, '--reason', 'not worth it'], lab)

  const store = await readJsonFile(join(lab, 'rejections.json'))
  assert(store[SIGNATURE], 'the rejection was not recorded')
  const until = Date.parse(store[SIGNATURE].until)
  assert(until > Date.now() + 80 * DAY && until < Date.now() + 100 * DAY, `cooldown is ${store[SIGNATURE].until}`)
  assert(store[SIGNATURE].reason === 'not worth it', 'the rejection reason was not recorded')

  const signatures = [{ key: SIGNATURE, kind: 'error', tool: 'edit', error: 'FsError/FS_NOT_OBSERVED', sessions: ['a', 'b'], projects: ['p1', 'p2', 'p3'], count: 4 }]
  const cooled = selectCandidates(signatures, { mode: 'global', rejections: store })
  assert(cooled.candidates.length === 0, 'a rejected signature is still a candidate')
  assert(cooled.cooling.has(SIGNATURE), 'the cooling set does not contain the rejection')

  run('apply-edits.mjs', ['--unreject', SIGNATURE], lab)
  const released = await readJsonFile(join(lab, 'rejections.json'))
  assert(!released[SIGNATURE], '--unreject left the record behind')
  const open = selectCandidates(signatures, { mode: 'global', rejections: released })
  assert(open.candidates.length === 1, 'the signature did not return after --unreject')
}

async function caseWatchPending() {
  const lab = await makeLab('watch-pending')
  await writeAdoption(lab, {
    id: 't-pending',
    at: daysAgo(2),
    baseline: { corpusSessions: 10, sessions: 10, hits: 10, hitsPerSession: 1 },
  })
  await appendExperience(lab, 't-pending')
  for (let i = 0; i < 3; i += 1) await writeDigest(lab, { id: `s${i}`, startedAt: daysAgo(1), hits: 1 })

  const result = run('watch.mjs', ['--now', NOW_ISO], lab)
  assert(result.output.includes('pending'), 'watch did not report pending')
  const experience = await readFile(join(lab, 'EXPERIENCE.md'), 'utf8')
  assert(experience.includes('**pending**'), 'watch resolved an adoption still inside the window')
  const record = await readJsonFile(join(lab, 'adoptions', 't-pending.json'))
  assert(!record.resolution, 'a pending adoption already has a resolution')
}

async function caseWatchKept() {
  const lab = await makeLab('watch-kept')
  await writeAdoption(lab, {
    id: 't-kept',
    at: daysAgo(20),
    baseline: { corpusSessions: 10, sessions: 10, hits: 10, hitsPerSession: 1 },
  })
  await appendExperience(lab, 't-kept')
  for (let i = 0; i < 12; i += 1) await writeDigest(lab, { id: `s${i}`, startedAt: daysAgo(10), hits: i === 0 ? 1 : 0 })

  run('watch.mjs', ['--now', NOW_ISO], lab)

  const record = await readJsonFile(join(lab, 'adoptions', 't-kept.json'))
  assert(record.resolution?.state === 'kept', `resolution is ${record.resolution?.state}, expected kept`)
  const experience = await readFile(join(lab, 'EXPERIENCE.md'), 'utf8')
  const lines = experience.split('\n').filter((line) => line.includes('`t-kept`'))
  assert(lines.length === 1, `the EXPERIENCE line was duplicated (${lines.length} lines)`)
  assert(lines[0].includes('**kept**'), 'the EXPERIENCE line was not relabelled')
  assert(!lines[0].includes('**pending**'), 'the EXPERIENCE line still says pending')

  run('watch.mjs', ['--now', NOW_ISO], lab)
  const again = (await readFile(join(lab, 'EXPERIENCE.md'), 'utf8')).split('\n').filter((line) => line.includes('`t-kept`'))
  assert(again.length === 1, 'a second watch run duplicated the EXPERIENCE line')
}

async function caseWatchReverted() {
  const lab = await makeLab('watch-reverted')
  await writeAdoption(lab, {
    id: 't-reverted',
    at: daysAgo(20),
    baseline: { corpusSessions: 10, sessions: 1, hits: 1, hitsPerSession: 0.1 },
  })
  await appendExperience(lab, 't-reverted')
  for (let i = 0; i < 12; i += 1) await writeDigest(lab, { id: `s${i}`, startedAt: daysAgo(10), hits: i < 6 ? 1 : 0 })

  run('watch.mjs', ['--now', NOW_ISO], lab)

  const record = await readJsonFile(join(lab, 'adoptions', 't-reverted.json'))
  assert(record.resolution?.state === 'reverted', `resolution is ${record.resolution?.state}, expected reverted`)
  const line = (await readFile(join(lab, 'EXPERIENCE.md'), 'utf8')).split('\n').find((text) => text.includes('`t-reverted`'))
  assert(line.includes('**reverted**'), 'the EXPERIENCE line was not relabelled reverted')
}

async function caseWatchInconclusive() {
  const lab = await makeLab('watch-inconclusive')
  await writeAdoption(lab, {
    id: 't-inconclusive',
    at: daysAgo(20),
    baseline: { corpusSessions: 10, sessions: 5, hits: 5, hitsPerSession: 0.5 },
  })
  await appendExperience(lab, 't-inconclusive')
  for (let i = 0; i < 12; i += 1) await writeDigest(lab, { id: `s${i}`, startedAt: daysAgo(10), hits: i < 6 ? 1 : 0 })

  run('watch.mjs', ['--now', NOW_ISO], lab)
  let record = await readJsonFile(join(lab, 'adoptions', 't-inconclusive.json'))
  assert(record.resolution?.state === 'inconclusive', `resolution is ${record.resolution?.state}, expected inconclusive`)

  // The rate drops in a later corpus: a provisional verdict must give way.
  await rm(join(lab, 'digests'), { recursive: true, force: true })
  await mkdir(join(lab, 'digests'), { recursive: true })
  for (let i = 0; i < 12; i += 1) await writeDigest(lab, { id: `s${i}`, startedAt: daysAgo(10), hits: 0 })

  run('watch.mjs', ['--now', NOW_ISO], lab)
  record = await readJsonFile(join(lab, 'adoptions', 't-inconclusive.json'))
  assert(record.resolution?.state === 'kept', `second resolution is ${record.resolution?.state}, expected kept`)
  const lines = (await readFile(join(lab, 'EXPERIENCE.md'), 'utf8'))
    .split('\n')
    .filter((text) => text.includes('`t-inconclusive`'))
  assert(lines.length === 1, `the provisional verdict duplicated the EXPERIENCE line (${lines.length})`)
  assert(lines[0].includes('**kept**') && !lines[0].includes('**inconclusive**'), 'the provisional marker was not replaced')
}

async function caseStatus() {
  const lab = await makeLab('status')
  const project = join(lab, 'project')
  await write(join(project, 'AGENTS.md'), '# Edited after adoption\n')

  await writeAdoption(lab, {
    id: 't-status',
    at: daysAgo(5),
    baseline: { corpusSessions: 1, sessions: 1, hits: 1, hitsPerSession: 1 },
    files: [{ index: 0, file: join(project, 'AGENTS.md'), existedBefore: false, deleted: false, afterHash: 'deadbeefdeadbeef' }],
  })
  await appendExperience(lab, 't-status')
  await appendExperience(lab, 't-orphan')

  const result = run('status.mjs', [], lab, { expect: 0 })
  assert(result.output.includes('orphan-experience-line'), 'status did not flag the orphan EXPERIENCE line')
  assert(result.output.includes('file-changed'), 'status did not flag the file edited after adoption')
}

async function main() {
  await rm(RUN, { recursive: true, force: true })
  await mkdir(RUN, { recursive: true })
  try {
    await caseApplier()
    await caseRejection()
    await caseWatchPending()
    await caseWatchKept()
    await caseWatchReverted()
    await caseWatchInconclusive()
    await caseStatus()
  } finally {
    await rm(RUN, { recursive: true, force: true })
    await rmdir(FIXTURES).catch(() => {})
  }
  return `PASS  7 cases: applier round-trip, signature rule, reject/unreject cooldown, watch pending/kept/reverted/inconclusive, status drift`
}

try {
  console.log(await main())
} catch (error) {
  await rm(RUN, { recursive: true, force: true }).catch(() => {})
  await rmdir(FIXTURES).catch(() => {})
  console.error(`FAIL  ${error.message}`)
  process.exit(1)
}
