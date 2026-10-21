#!/usr/bin/env node
/**
 * The unattended sweep: digest, watch, status, and (monthly) audit.
 *
 *   node scripts/sweep.mjs                 # weekly window, audit on the 1st
 *   node scripts/sweep.mjs --audit         # force the monthly pass
 *   node scripts/sweep.mjs --since 30 --json
 *
 * This is the cron entry point, so it obeys three rules:
 *
 * 1. It never writes outside the lab. It runs `apply` never, and `--write` nowhere.
 * 2. It reports what a human must decide: new candidates, fresh verdicts, audit
 *    findings. Exit 1 means "read the report", 0 means "nothing to do".
 * 3. It degrades: a failing step is recorded and the rest still run, because a
 *    silent cron job that stops working looks exactly like a quiet week.
 *
 * Attention is derived from records this lab already owns — the digest's run
 * file, adoption resolutions, and `audit --strict`'s exit code — rather than from
 * each command's JSON, so a formatting change cannot silently disable alerting.
 */
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CODE_ROOT, nowIso, paths, readJson, readText, writeText } from './lib/lab.mjs'

const SCRIPTS = join(CODE_ROOT, 'scripts')
// Reports are state, not code: `HARNESS_LAB_DIR` must redirect them too, or a
// test run writes into the real lab.
const REPORTS = join(paths.root, 'reports')

function parseArgs(argv) {
  const args = { since: 7, audit: false, json: false, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--since') args.since = Number(argv[++i])
    else if (arg === '--audit') args.audit = true
    else if (arg === '--json') args.json = true
    else if (arg === '--quiet') args.quiet = true
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: sweep.mjs [--since DAYS] [--audit] [--json] [--quiet]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isFinite(args.since) || args.since <= 0) throw new Error('--since must be a positive number of days')
  return args
}

/** Run one lab script and keep its streams; never throws on a non-zero status. */
function run(script, argv) {
  const result = spawnSync(process.execPath, [join(SCRIPTS, script), ...argv], {
    cwd: CODE_ROOT,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.error) return { status: 1, stdout: '', stderr: result.error.message, failed: true }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    failed: result.status === null,
  }
}

/** The digest writes one run record per invocation; the newest is this run's. */
async function newestRunRecord() {
  const names = (await readdir(paths.runs).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
  if (names.length === 0) return null
  return readJson(join(paths.runs, names[names.length - 1]), null)
}

/** Verdicts decided today, so a resolved adoption alerts once rather than nightly. */
async function verdictsToday(today) {
  const names = (await readdir(paths.adoptions).catch(() => [])).filter((name) => name.endsWith('.json'))
  const resolved = []
  for (const name of names) {
    const record = await readJson(join(paths.adoptions, name), null)
    const state = record?.resolution?.state
    if (!state) continue
    const at = record.resolution.at ?? ''
    if (at.startsWith(today)) resolved.push({ id: record.id, state, at })
  }
  return resolved
}

function section(title, result) {
  const body = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n')
  const note = result.status === 0 ? '' : ` (exit ${result.status})`
  return `## ${title}${note}\n\n${body ? `\`\`\`\n${body}\n\`\`\`` : '_no output_'}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const monthly = args.audit || now.getDate() === 1
  const attention = []
  const failures = []

  const digest = run('digest.mjs', ['--since', String(args.since)])
  if (digest.status !== 0) failures.push('digest')

  const watch = run('watch.mjs', [])
  if (watch.status !== 0) failures.push('watch')

  const status = run('status.mjs', [])
  if (status.status !== 0) failures.push('status')

  let audit = null
  if (monthly) {
    // --strict turns "something is actionable" into an exit code, which is more
    // durable than parsing this command's prose.
    audit = run('audit.mjs', ['--strict'])
    if (audit.status !== 0 && audit.status !== 1) failures.push('audit')
  }

  const record = await newestRunRecord()
  const candidates = record?.candidates ?? []
  if (candidates.length > 0) {
    attention.push(`${candidates.length} signature(s) above the bar — run \`evidence\`, then propose`)
    for (const candidate of candidates.slice(0, 3)) {
      attention.push(`  · ${candidate.key} — ${candidate.projects.length} project(s), ${candidate.sessions.length} session(s), ${candidate.hits} hit(s)`)
    }
  }

  const verdicts = await verdictsToday(today)
  for (const verdict of verdicts) {
    attention.push(`${verdict.id} resolved **${verdict.state}** — record it or revert it`)
  }

  if (audit && audit.status === 1) attention.push('audit found rebalancing candidates — read the section below')

  const experience = (await readText(paths.experience)) ?? ''
  // Match the id slot only. A looser backtick match captured the *last* quoted
  // token on a line, so a rationale quoting a path looked like an orphan id and
  // the sweep nagged about an adoption that was perfectly fine.
  const orphan = /^-\s+\d{4}-\d{2}-\d{2}\s+·\s+`([^`]+)`/gm
  const adoptionNames = new Set(
    (await readdir(paths.adoptions).catch(() => [])).map((name) => name.replace(/\.json$/, '')),
  )
  for (const match of experience.matchAll(orphan)) {
    if (!adoptionNames.has(match[1])) {
      attention.push(`EXPERIENCE line \`${match[1]}\` has no adoption record — run \`status\``)
      break
    }
  }

  const lines = [
    `# Harness sweep — ${today}`,
    '',
    `Window ${args.since}d · corpus ${record?.totals?.sessions ?? '?'} session(s) · audit ${monthly ? 'ran' : 'skipped'}`,
    '',
    '## Attention',
    '',
    attention.length ? attention.map((item) => (item.startsWith('  ') ? item : `- ${item}`)).join('\n') : '- nothing needs a human this run',
    '',
  ]
  if (failures.length) lines.push(`**Steps failed:** ${failures.join(', ')} — the report below may be incomplete.`, '')

  lines.push(section('digest', digest), section('watch', watch), section('status', status))
  if (audit) lines.push(section('audit', audit))

  const report = `${lines.join('\n')}\n`
  await writeText(join(REPORTS, `${today}.md`), report)
  await writeText(join(REPORTS, 'latest.md'), report)

  const summary = {
    at: nowIso(),
    date: today,
    attention: attention.filter((item) => !item.startsWith('  ')).length,
    candidates: candidates.length,
    verdicts,
    failures,
    report: join(REPORTS, `${today}.md`),
  }

  if (args.json) console.log(JSON.stringify(summary, null, 2))
  else if (!args.quiet) console.log(report)

  if (failures.length) return 2
  return attention.length > 0 ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`sweep failed: ${error.stack ?? error.message}`)
    process.exitCode = 2
  })
