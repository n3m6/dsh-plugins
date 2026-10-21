#!/usr/bin/env node
/**
 * Digest session logs into metric vectors, friction moments, and signatures.
 *
 *   node scripts/digest.mjs                     # every corpus, 3-project bar
 *   node scripts/digest.mjs --project ~/work/x  # one project, 2-session bar
 *   node scripts/digest.mjs --since 90 --json
 *
 * Writes one digest per session, a signature cluster, and a run record. A run
 * with no candidate signature is a success and is recorded as `verdict: quiet`.
 */
import { resolve } from 'node:path'
import {
  paths,
  readJson,
  writeJson,
  nowIso,
  stamp,
  median,
  pct,
  expandHome,
} from './lib/lab.mjs'
import { listSessionFiles, readSession, buildDigest } from './lib/sessions.mjs'
import { collectSignatures, candidatesFor, activeRejections } from './lib/signatures.mjs'

function parseArgs(argv) {
  const args = { all: true, since: 30, json: false, project: null, session: null, limit: 40 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--all') args.all = true
    else if (arg === '--project') args.project = resolve(expandHome(argv[++i]))
    else if (arg === '--session') args.session = argv[++i]
    else if (arg === '--since') args.since = Number(argv[++i]) || 30
    else if (arg === '--limit') args.limit = Number(argv[++i]) || 40
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: digest.mjs [--all | --project <dir> | --session <id>] [--since <days>] [--limit <n>] [--json]`)
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (args.project) args.all = false
  if (args.session) args.all = false
  return args
}

function tokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cutoff = Date.now() - args.since * 86_400_000
  const files = await listSessionFiles()
  const digests = []
  let skipped = 0

  for (const entry of files) {
    if (args.session && !entry.sessionDir.includes(args.session)) continue
    if (!args.session && entry.mtimeMs < cutoff) {
      skipped += 1
      continue
    }
    let session
    try {
      session = await readSession(entry.file)
    } catch (error) {
      console.error(`skip ${entry.sessionDir}: ${error.message}`)
      continue
    }
    if (args.project) {
      const cwd = session.cwd ?? ''
      if (cwd !== args.project && !cwd.startsWith(`${args.project}/`)) continue
    }
    const digest = buildDigest(session, entry.file)
    digests.push(digest)
    await writeJson(`${paths.digests}/${digest.sessionId}.json`, digest)
  }

  const mode = args.project ? 'project' : 'global'
  const signatures = collectSignatures(digests)
  const rejections = await readJson(paths.rejections, {})
  const cooling = activeRejections(rejections)
  const eligible = signatures.filter((entry) => !cooling.has(entry.key))
  const candidates = candidatesFor(eligible, { mode }).slice(0, args.limit)

  const totalCalls = digests.reduce((sum, d) => sum + d.metrics.toolCalls, 0)
  const totalErrors = digests.reduce((sum, d) => sum + d.metrics.toolErrors, 0)
  const totalTokens = digests.reduce(
    (sum, d) => sum + d.metrics.tokens.input + d.metrics.tokens.output + d.metrics.tokens.reasoning,
    0,
  )
  const projects = [...new Set(digests.map((d) => d.project).filter(Boolean))]

  const runId = `${stamp()}-${mode}`
  const run = {
    id: runId,
    at: nowIso(),
    mode,
    project: args.project ?? null,
    sinceDays: args.since,
    digested: digests.length,
    skippedByWindow: skipped,
    projects,
    totals: { sessions: digests.length, toolCalls: totalCalls, toolErrors: totalErrors, tokens: totalTokens },
    candidates: candidates.map((entry) => ({
      key: entry.key,
      projects: entry.projects,
      sessions: entry.sessions,
      hits: entry.count,
    })),
    cooling: [...cooling.keys()].filter((key) => signatures.some((entry) => entry.key === key)),
    verdict: candidates.length ? 'proposed' : 'quiet',
  }

  await writeJson(paths.signatures, { generatedAt: run.at, mode, signatures, candidates: run.candidates })
  await writeJson(`${paths.runs}/${runId}.json`, run)

  if (args.json) {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  const bar = mode === 'project' ? '2 sessions in project' : '3 projects'
  console.log(`\nHarness Lab — digest ${run.at}`)
  console.log(`  scope           ${mode}${args.project ? ` (${args.project})` : ''}`)
  console.log(`  window          last ${args.since} days${skipped ? ` (${skipped} older skipped)` : ''}`)
  console.log(`  sessions        ${digests.length} across ${projects.length} projects`)
  console.log(
    `  tool calls      ${totalCalls.toLocaleString()}   errors ${totalErrors.toLocaleString()} (${pct(totalCalls ? totalErrors / totalCalls : 0)})`,
  )
  console.log(`  median steps    ${median(digests.map((d) => d.metrics.steps))}`)
  console.log(`  tokens          ${tokens(totalTokens)}`)
  console.log(`\n  candidates (bar: ${bar})`)

  if (!candidates.length) {
    console.log('    — none. Silence is the correct outcome; nothing recurs enough to act on.')
  }
  for (const [index, entry] of candidates.entries()) {
    console.log(
      `\n   ${index + 1}. ${entry.key}   ${entry.projects.length} projects · ${entry.sessions.length} sessions · ${entry.count} hits`,
    )
    for (const sample of entry.samples.slice(0, 1)) console.log(`      e.g. ${sample}`)
  }
  if (cooling.size) console.log(`\n  cooling (rejected: ${[...cooling.keys()].join(', ')})`)
  console.log(`\n  run             ${runId}   verdict: ${run.verdict}\n`)
}

main().catch((error) => {
  console.error(`digest failed: ${error.stack ?? error.message}`)
  process.exit(1)
})
