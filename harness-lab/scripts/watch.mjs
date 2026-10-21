#!/usr/bin/env node
/**
 * Resolve adoptions: did the edit actually move the rate it claimed to move?
 *
 *   node scripts/watch.mjs            # judge every open adoption
 *   node scripts/watch.mjs --json
 *   node scripts/watch.mjs --now 2026-11-01T00:00:00Z
 *
 * An adoption stays `pending` until its signature has been observed for the
 * watch window (10 sessions that started after the adoption, or 14 days,
 * whichever comes later). Then the rate over those later sessions is compared
 * with the baseline frozen at apply time, and the EXPERIENCE.md line is rewritten
 * in place — never duplicated.
 *
 * `kept` and `reverted` are final. `inconclusive` is provisional: a flat rate may
 * only mean the corpus is still too small, so it is re-judged on every run.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nowIso, paths, readJson, readText, writeJson, writeText } from './lib/lab.mjs'
import { classifyOutcome, loadDigests, measureSignature } from './lib/measure.mjs'

/** Later sessions needed before a verdict is trusted. */
export const WATCH_SESSIONS = 10
/** Days after which a verdict is reached even with few later sessions. */
export const WATCH_DAYS = 14
const DAY_MS = 86_400_000

function parseArgs(argv) {
  const args = { json: false, now: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') args.json = true
    else if (arg === '--now') args.now = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: watch.mjs [--json] [--now <iso>]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (args.now === null) args.now = nowIso()
  if (Number.isNaN(Date.parse(args.now))) throw new Error(`--now is not a date: ${args.now}`)
  return args
}

async function listAdoptions() {
  const entries = await readdir(paths.adoptions).catch(() => [])
  const adoptions = []
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue
    const record = await readJson(join(paths.adoptions, name), null)
    if (record) adoptions.push(record)
  }
  return adoptions
}

/** Any outcome marker, so an inconclusive line can later become kept. */
const MARKER = /\*\*(pending|kept|reverted|inconclusive)\*\*/

/**
 * Replace the outcome marker on one adoption's EXPERIENCE line.
 * The line is found by its backticked id, so a rationale that mentions another
 * id cannot capture it. A previous `inconclusive` is replaceable because a flat
 * rate is provisional; `kept` and `reverted` never reach here.
 * @returns {Promise<boolean>} whether the file changed
 */
async function relabelExperience(id, label) {
  const text = await readText(paths.experience)
  if (text === null) return false
  let changed = false
  const lines = text.split('\n').map((line) => {
    if (!line.includes(`\`${id}\``)) return line
    if (!MARKER.test(line)) return line
    changed = true
    return line.replace(MARKER, label)
  })
  if (changed) await writeText(paths.experience, lines.join('\n'))
  return changed
}

function rate(value) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(2)
}

function label(change, state, reason) {
  const numbers = `${rate(change.before)} → ${rate(change.after)} hits/session`
  const note = reason ? `; ${reason}` : ''
  return `**${state}** (${numbers}${note})`
}

async function judge(adoption, { digests, now }) {
  if (adoption.revertedAt) {
    return { id: adoption.id, signature: adoption.signature, state: 'reverted-manually', progress: null }
  }
  if (!adoption.signature) {
    return { id: adoption.id, signature: null, state: 'unmeasurable', progress: null }
  }
  const settled = adoption.resolution
  if (settled && settled.state !== 'inconclusive') {
    return { id: adoption.id, signature: adoption.signature, state: settled.state, progress: null, settled: true }
  }

  const adoptedAt = Date.parse(adoption.at)
  const later = digests.filter((digest) => {
    const started = digest.startedAt ? Date.parse(digest.startedAt) : Number.NaN
    return Number.isFinite(started) && started > adoptedAt
  })
  const ageDays = (Date.parse(now) - adoptedAt) / DAY_MS
  const progress = {
    sessions: later.length,
    needed: WATCH_SESSIONS,
    days: Math.max(0, Math.floor(ageDays)),
    daysNeeded: WATCH_DAYS,
  }

  const measured = measureSignature(later, adoption.signature)
  const change = { before: adoption.baseline?.hitsPerSession ?? null, after: measured.hitsPerSession }
  const waiting = progress.sessions < WATCH_SESSIONS && progress.days < WATCH_DAYS
  if (waiting) {
    return {
      id: adoption.id,
      signature: adoption.signature,
      state: 'pending',
      progress,
      change,
      measured,
    }
  }

  const outcome = classifyOutcome(adoption.baseline, measured)
  return {
    id: adoption.id,
    signature: adoption.signature,
    state: outcome.state,
    reason: outcome.reason,
    progress,
    change,
    measured,
    resolvedNow: true,
  }
}

async function persist(result, now) {
  if (!result.resolvedNow) return
  const record = await readJson(join(paths.adoptions, `${result.id}.json`), null)
  if (!record) return
  record.resolution = {
    state: result.state,
    at: now,
    reason: result.reason ?? null,
    after: result.measured,
    before: record.baseline,
  }
  await writeJson(join(paths.adoptions, `${result.id}.json`), record)
  await relabelExperience(result.id, label(result.change, result.state, result.reason))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const digests = await loadDigests(paths.digests)
  const adoptions = await listAdoptions()
  const results = []

  for (const adoption of adoptions) {
    const result = await judge(adoption, { digests, now: args.now })
    await persist(result, args.now)
    results.push(result)
  }

  if (args.json) {
    console.log(JSON.stringify({ at: args.now, corpusSessions: digests.length, adoptions: results }, null, 2))
    return
  }

  console.log(`\nHarness Lab — watch  ${args.now}  (corpus ${digests.length} session(s))`)
  if (results.length === 0) {
    console.log('  no adoptions yet')
  }
  for (const result of results) {
    const where = result.signature ?? '(no signature)'
    const progress = result.progress
      ? `${result.progress.sessions}/${result.progress.needed} sessions · ${result.progress.days}/${result.progress.daysNeeded} days`
      : ''
    const change = result.change ? `  ${rate(result.change.before)} → ${rate(result.change.after)}` : ''
    console.log(`  ${result.id.padEnd(20)} ${result.state.padEnd(18)} ${where}${change}`)
    if (progress) console.log(`  ${''.padEnd(20)} ${progress}`)
    if (result.reason) console.log(`  ${''.padEnd(20)} ${result.reason}`)
  }
  const open = results.filter((result) => result.state === 'pending').length
  console.log(`\n  ${results.length - open} resolved, ${open} pending\n`)
}

main().catch((error) => {
  console.error(`watch failed: ${error.message}`)
  process.exit(1)
})
