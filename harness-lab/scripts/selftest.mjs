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
import { lstat, mkdir, rm, rmdir, utimes, writeFile, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { zstdCompressSync } from 'node:zlib'

import { collectSignatures, selectCandidates } from './lib/signatures.mjs'
import { listSessionFiles, readSession } from './lib/sessions.mjs'
import { measureSignature } from './lib/measure.mjs'

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
/** Write one zstd-compressed session artifact, the way DSH persists them. */
async function writeCompressed(file, text) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, zstdCompressSync(Buffer.from(text, 'utf8')))
}

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

/** Run a Node entry point with the lab environment applied. */
function spawnNode(scriptPath, args, { lab, cwd, env = {}, expect = 0 } = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: cwd ?? lab,
    encoding: 'utf8',
    env: { ...process.env, ...(lab ? { HARNESS_LAB_DIR: lab } : {}), ...env },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (expect !== null && result.status !== expect) {
    throw new Error(`${basename(scriptPath)} ${args.join(' ')} exited ${result.status}\n${output}`)
  }
  return { status: result.status, output }
}

/** Run one lab script against a throwaway lab. */
function run(script, args, lab, options = {}) {
  return spawnNode(join(SCRIPTS, script), args, { lab, ...options })
}

/** Run the dispatcher, optionally from a directory outside the checkout. */
function dispatch(args, options = {}) {
  return spawnNode(join(SCRIPTS, 'harness.mjs'), args, options)
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

/**
 * A capped moment list must not become a capped count.
 *
 * The first implementation stored three moments per session and clustered those,
 * so a signature with 110 occurrences was reported as 39. Digests now carry a
 * whole-session histogram; this pins both the histogram path and the fallback
 * for digests written before the field existed.
 */
async function caseHistogram() {
  const signature = 'edit:FsError/FS_NOT_OBSERVED'
  const moment = { kind: 'error', step: 1, tool: 'edit', error: 'FsError/FS_NOT_OBSERVED', snippet: 'x', at: null }
  const withHistogram = {
    sessionId: 'h1',
    project: 'proj',
    startedAt: daysAgo(3),
    metrics: { signatures: { [signature]: 5, 'repeat:bash': 2 } },
    moments: [moment],
  }
  const legacy = {
    sessionId: 'h2',
    project: 'proj',
    startedAt: daysAgo(2),
    metrics: {},
    moments: [moment, moment, moment],
  }

  const dense = collectSignatures([withHistogram]).find((entry) => entry.key === signature)
  assert(dense, 'histogram: signature missing from the cluster')
  assert(dense.count === 5, `histogram: expected 5 occurrences, got ${dense.count}`)
  assert(dense.sessions.length === 1, 'histogram: session not counted')

  const fallback = collectSignatures([legacy]).find((entry) => entry.key === signature)
  assert(fallback?.count === 3, `histogram: legacy fallback expected 3, got ${fallback?.count}`)

  const rate = measureSignature([withHistogram, legacy], signature)
  assert(rate.hits === 8, `histogram: expected 8 hits across both digests, got ${rate.hits}`)
  assert(rate.sessions === 2, `histogram: expected 2 sessions, got ${rate.sessions}`)
  assert(rate.hitsPerSession === 4, `histogram: expected 4 hits/session, got ${rate.hitsPerSession}`)

  const repeat = measureSignature([withHistogram, legacy], 'repeat:bash')
  assert(repeat.hits === 2 && repeat.sessions === 1, 'histogram: non-error family miscounted')
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

/**
 * Session artifacts are versioned and their directory names are not stable.
 *
 * The first implementation matched one literal filename inside `session-*`
 * directories, so it read 46 of 187 sessions, all of them from August, and
 * silently reported a two-month-stale corpus as if it were current. This pins
 * both axes: the name suffix and the directory shape.
 */
async function caseSessionFormats() {
  const root = join(RUN, 'sessions-formats')
  const corpus = join(root, '--fixture--')
  const header = (id, version) => `${JSON.stringify({ type: 'session', version, id, cwd: '/fixture', createdAt: NOW - DAY })}\n`
  const at = (file, text) => writeCompressed(file, text)

  await at(join(corpus, 'session-legacy', 'session.jsonl.zstd'), header('legacy', 0))
  await at(join(corpus, 'bare-uuid', 'session.v4.jsonl.zstd'), header('modern', 4))
  await at(join(corpus, 'mixed', 'session.jsonl.zstd'), header('old-copy', 0))
  await at(join(corpus, 'mixed', 'session.v4.jsonl.zstd'), header('new-copy', 4))

  const files = await listSessionFiles(root)
  assert(files.length === 3, `expected 3 sessions (newest format per directory), got ${files.length}`)
  const versions = files.map((entry) => entry.version).sort()
  assert(versions.join() === '0,4,4', `unexpected formats discovered: ${versions.join()}`)

  const mixed = files.find((entry) => entry.sessionDir === 'mixed')
  const parsed = await readSession(mixed.file)
  assert(parsed.id === 'new-copy', `newest format did not win in a mixed directory: ${parsed.id}`)
  assert(parsed.formatVersion === 4, `format version not read: ${parsed.formatVersion}`)

  const legacy = await readSession(files.find((entry) => entry.sessionDir === 'session-legacy').file)
  assert(legacy.id === 'legacy' && legacy.formatVersion === 0, 'legacy artifact not parsed')
}

async function caseEvidence() {
  const lab = await makeLab('evidence')
  const sessions = join(RUN, 'evidence', 'sessions')
  const project = '/fixture/repo'
  const result = (callId, error) => ({
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      ...(error ? { error } : {}),
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: error ? 'Error: cannot edit foo.md without reading it first' : 'ok' }] }],
      },
    },
  })
  const call = (callId, name, args) => ({ type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } })
  const line = (value) => JSON.stringify(value)

  // Session A: bash sees the file, then the edit fails — the pattern to surface.
  await write(join(sessions, 'corpus-a', 'session-aaaa', 'session.jsonl'), [
    line({ type: 'session', id: 'session-aaaa', cwd: project, agentPreset: 'standard' }),
    line(call('c1', 'bash', { command: 'cat foo.md' })),
    line(result('c1')),
    line(call('c2', 'edit', { file_path: 'foo.md' })),
    line(result('c2', { name: 'FsError', code: 'FS_NOT_OBSERVED' })),
    line(call('c3', 'bash', { command: 'ls' })),
    line(result('c3')),
    line(call('c4', 'bash', { command: 'ls' })),
    line(result('c4')),
    line({ type: 'compaction/start', data: {} }),
  ].join('\n'))

  // Session B: a successful read then an unrelated edit — no occurrence.
  await write(join(sessions, 'corpus-b', 'session-bbbb', 'session.jsonl'), [
    line({ type: 'session', id: 'session-bbbb', cwd: project, agentPreset: 'standard' }),
    line(call('d1', 'read', { file_path: 'bar.md' })),
    line(result('d1')),
    line(call('d2', 'edit', { file_path: 'bar.md' })),
    line(result('d2')),
  ].join('\n'))

  const env = { DSH_SESSIONS_DIR: sessions }
  const error = JSON.parse(run('evidence.mjs', ['--signature', SIGNATURE, '--json'], lab, { env }).output)
  assert(error.occurrences === 1, `error occurrences is ${error.occurrences}, expected 1`)
  assert(error.touchedBy.bash === 1, `bash touch count is ${error.touchedBy.bash}, expected 1`)
  assert(!error.touchedBy.read, `a read was counted as touching the target: ${error.touchedBy.read}`)
  assert(error.immediatelyBefore.bash === 1, 'the call before the failure was not recorded as bash')
  assert(error.samples[0].before.length === 1, 'the sample did not keep the configured context')

  const repeat = JSON.parse(run('evidence.mjs', ['--signature', 'repeat:bash', '--json'], lab, { env }).output)
  assert(repeat.occurrences === 1, `repeat occurrences is ${repeat.occurrences}, expected 1`)

  const compaction = JSON.parse(run('evidence.mjs', ['--signature', 'compaction', '--json'], lab, { env }).output)
  assert(compaction.occurrences === 1, `compaction occurrences is ${compaction.occurrences}, expected 1`)

  const first = run('evidence.mjs', ['--signature', SIGNATURE, '--json'], lab, { env }).output
  const second = run('evidence.mjs', ['--signature', SIGNATURE, '--json'], lab, { env }).output
  assert(first === second, 'evidence --json output is not stable across runs')

  const text = run('evidence.mjs', ['--signature', SIGNATURE], lab, { env }).output
  assert(/touched since last write/.test(text), 'the aggregate line is missing from the text report')
  assert(/bash 1 /.test(text), 'the text report does not show the bash count')
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

async function caseDispatcher() {
  const lab = await makeLab('dispatcher')

  const help = dispatch(['--help'], { lab })
  assert(help.output.includes('digest') && help.output.includes('selftest'), 'help does not list the commands')
  assert(help.output.includes('reject'), 'help does not list reject')

  const status = dispatch(['status'], { lab })
  assert(/status/i.test(status.output), 'the dispatcher did not reach status.mjs')

  // A child's non-zero exit must survive the hop.
  const failing = dispatch(['apply', '--set', join(lab, 'missing.json')], { lab, expect: null })
  assert(failing.status !== 0, 'the dispatcher swallowed a child failure')

  // `audit` is implemented and must run through the dispatcher.
  const audit = dispatch(['audit', '--json'], {
    lab,
    env: { AGENTS_HOME: join(lab, 'agents-home'), DSH_HOME: join(lab, 'dsh-home') },
  })
  assert(/"caveats"/.test(audit.output), 'the dispatcher did not reach audit.mjs')

  // `reject <key>` is sugar for `--reject <key>`; the rest of the args pass through.
  dispatch(['reject', SIGNATURE, '--reason', 'via dispatcher'], { lab })
  const store = await readJsonFile(join(lab, 'rejections.json'))
  assert(store[SIGNATURE]?.reason === 'via dispatcher', 'the dispatcher did not forward reject')
  dispatch(['unreject', SIGNATURE], { lab })
  assert(!(await readJsonFile(join(lab, 'rejections.json')))[SIGNATURE], 'the dispatcher did not forward unreject')
}

async function caseInstall() {
  const lab = await makeLab('install')
  const agents = join(lab, 'agents-home')
  const env = { AGENTS_HOME: agents }
  const install = join(SCRIPTS, 'install.mjs')
  const target = join(agents, 'skills', 'harness-improve')

  const before = spawnNode(install, ['--check'], { lab, env })
  assert(/absent/.test(before.output), 'check did not report the skill as absent')
  assert(/ready/.test(before.output), 'check reported trouble before anything was installed')

  const installed = spawnNode(install, ['--install'], { lab, env })
  assert(/installed/.test(installed.output), 'install did not report success')
  const entry = await lstat(target)
  const ours = entry.isSymbolicLink() || (entry.isDirectory() && (await exists(join(target, '.harness-lab-install'))))
  assert(ours, 'install produced neither a symlink nor a marked copy')

  const again = spawnNode(install, ['--install'], { lab, env })
  assert(/already installed/.test(again.output), 'install is not idempotent')

  const after = spawnNode(install, ['--check'], { lab, env })
  assert(/install\s+ok/.test(after.output), 'check did not recognise the install')

  spawnNode(install, ['--uninstall'], { lab, env })
  assert(!(await exists(target)), 'uninstall left the entry behind')
}


/** One digest carrying skill invocations, which is what the audit reads. */
async function writeSkillDigest(lab, { id, cwd, startedAt, uses }) {
  await write(join(lab, 'digests', `${id}.json`), JSON.stringify({ sessionId: id, cwd, startedAt, metrics: { skillInvocations: uses ?? {} } }))
}

async function caseAudit() {
  const lab = await makeLab('audit')
  const agentsHome = join(lab, 'agents-home')
  const dshHome = join(lab, 'dsh-home')
  const projA = join(lab, 'proj-a')
  const projB = join(lab, 'proj-b')
  const env = { AGENTS_HOME: agentsHome, DSH_HOME: dshHome, HARNESS_LAB_DIR: lab }
  const skill = (name) => `---\nname: ${name}\ndescription: fixture\n---\nBody.\n`

  await write(join(agentsHome, 'skills', 'old-unused', 'SKILL.md'), skill('old-unused'))
  await write(join(agentsHome, 'skills', 'single-project', 'SKILL.md'), skill('single-project'))
  await write(join(agentsHome, 'skills', 'busy', 'SKILL.md'), skill('busy'))
  await write(join(dshHome, 'AGENTS.md'), `# big\n${'x'.repeat(60000)}\n`)
  // A `.git` marker stops the project-root walk at the fixture instead of the real repo.
  await write(join(projA, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await write(join(projB, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await write(join(projA, '.agents', 'skills', 'shared', 'SKILL.md'), skill('shared'))
  await write(join(projB, '.agents', 'skills', 'shared', 'SKILL.md'), skill('shared'))

  const old = new Date(NOW - 100 * DAY)
  await utimes(join(agentsHome, 'skills', 'old-unused', 'SKILL.md'), old, old)

  await writeSkillDigest(lab, { id: 'a1', cwd: projA, startedAt: daysAgo(5), uses: { 'single-project': 1, busy: 2 } })
  await writeSkillDigest(lab, { id: 'a2', cwd: projB, startedAt: daysAgo(4), uses: { busy: 1 } })

  const result = run('audit.mjs', ['--json', '--now', NOW_ISO, '--since', '90'], lab, { env })
  const report = JSON.parse(result.output)

  assert(report.corpus.sessions === 2, `audit counted ${report.corpus.sessions} sessions, expected 2`)
  const prune = report.candidates.prune.map((entry) => entry.name)
  assert(prune.includes('old-unused'), 'an old, unused, unreferenced skill was not a prune candidate')
  assert(!prune.includes('busy'), 'a used skill was flagged for pruning')
  assert(!prune.includes('single-project'), 'a recent skill was flagged for pruning')

  const demote = report.candidates.demote.map((entry) => entry.name)
  assert(demote.includes('single-project'), 'a user skill used from one project was not a demote candidate')
  assert(!demote.includes('busy'), 'a skill used from two projects was flagged for demotion')

  const promote = report.candidates.promote.find((entry) => entry.name === 'shared')
  assert(promote, 'a skill defined under two project roots was not a promote candidate')
  assert(promote.copies === 2 && promote.variants === 1, `promote reports ${promote.copies} copies / ${promote.variants} variants`)

  const compress = report.candidates.compress.map((entry) => entry.file)
  assert(compress.some((file) => file.endsWith('AGENTS.md')), 'an over-budget AGENTS.md was not a compress candidate')

  // A corpus that never calls the skill tool must not report every skill as unused.
  const quiet = await makeLab('audit-quiet')
  const quietAgents = join(quiet, 'agents-home')
  await write(join(quietAgents, 'skills', 'never-called', 'SKILL.md'), skill('never-called'))
  const quietOld = new Date(NOW - 200 * DAY)
  await utimes(join(quietAgents, 'skills', 'never-called', 'SKILL.md'), quietOld, quietOld)
  await writeSkillDigest(quiet, { id: 'q1', cwd: join(quiet, 'p'), startedAt: daysAgo(3), uses: {} })

  const quietReport = JSON.parse(
    run('audit.mjs', ['--json', '--now', NOW_ISO], quiet, { env: { AGENTS_HOME: quietAgents, DSH_HOME: join(quiet, 'dsh-home') } }).output,
  )
  assert(quietReport.candidates.prune.length === 0, 'prune fired on a corpus with no skill invocations')
  assert(
    quietReport.caveats.some((line) => /never invoked/.test(line)),
    'the report did not explain that use counts carry no signal here',
  )

  const strict = run('audit.mjs', ['--now', NOW_ISO, '--strict'], lab, { env, expect: null })
  assert(strict.status === 1, `--strict exited ${strict.status} with candidates present`)
}

async function caseCwd() {
  const lab = await makeLab('cwd')
  const elsewhere = join(lab, 'elsewhere')
  const sessions = join(lab, 'sessions')
  await mkdir(elsewhere, { recursive: true })
  await mkdir(sessions, { recursive: true })

  const status = dispatch(['status'], { lab, cwd: elsewhere })
  assert(/status/i.test(status.output), 'status does not run from outside the checkout')

  const digest = dispatch(['digest', '--since', '1'], { lab, cwd: elsewhere, env: { DSH_SESSIONS_DIR: sessions } })
  assert(/scope\s+global/.test(digest.output), 'digest does not run from outside the checkout')
}

async function main() {
  await rm(RUN, { recursive: true, force: true })
  await mkdir(RUN, { recursive: true })
  try {
    await caseApplier()
    await caseHistogram()
    await caseSessionFormats()
    await caseRejection()
    await caseWatchPending()
    await caseWatchKept()
    await caseWatchReverted()
    await caseWatchInconclusive()
    await caseEvidence()
    await caseStatus()
    await caseDispatcher()
    await caseAudit()
    await caseInstall()
    await caseCwd()
  } finally {
    await rm(RUN, { recursive: true, force: true })
    await rmdir(FIXTURES).catch(() => {})
  }
  return `PASS  14 cases: applier round-trip, signature rule, histogram, session formats, reject/unreject cooldown, watch pending/kept/reverted/inconclusive, evidence blocks/aggregate, status drift, dispatcher, audit rules, install, cwd independence`
}

try {
  console.log(await main())
} catch (error) {
  await rm(RUN, { recursive: true, force: true }).catch(() => {})
  await rmdir(FIXTURES).catch(() => {})
  console.error(`FAIL  ${error.message}`)
  process.exit(1)
}
