#!/usr/bin/env node
/**
 * Manage the crontab entry that runs `scripts/sweep.mjs`.
 *
 *   node scripts/install-cron.mjs            # check (default)
 *   node scripts/install-cron.mjs --install
 *   node scripts/install-cron.mjs --remove
 *
 * The entry is one marked block, so installing twice is a no-op, removing takes
 * only this block, and every other line in your crontab is left byte-for-byte
 * alone. `crontab` does not load nvm, so the line names the running node binary
 * by absolute path instead of relying on PATH.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CODE_ROOT, paths } from './lib/lab.mjs'

const BEGIN = '# >>> harness-lab sweep (managed) >>>'
const END = '# <<< harness-lab sweep (managed) <<<'
/** 08:15 daily: after the night's sessions, before the working day. */
const SCHEDULE = '15 8 * * *'

function parseArgs(argv) {
  const args = { mode: 'check' }
  for (const arg of argv) {
    if (arg === '--install') args.mode = 'install'
    else if (arg === '--remove') args.mode = 'remove'
    else if (arg === '--check') args.mode = 'check'
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: install-cron.mjs [--check | --install | --remove]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function desiredLine() {
  const node = process.execPath
  return `${SCHEDULE} cd ${CODE_ROOT} && ${node} scripts/sweep.mjs >> ${join(paths.root, 'reports', 'cron.log')} 2>&1`
}

function desiredBlock() {
  return `${BEGIN}\n${desiredLine()}\n${END}`
}

/** Current crontab text; a missing crontab is an empty one. */
function readCrontab() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' })
  if (result.error) return { ok: false, reason: `crontab not available: ${result.error.message}` }
  if (result.status === 0) return { ok: true, text: result.stdout ?? '' }
  const stderr = (result.stderr ?? '').toLowerCase()
  if (stderr.includes('no crontab')) return { ok: true, text: '' }
  return { ok: false, reason: (result.stderr ?? '').trim() || `crontab -l exited ${result.status}` }
}

function writeCrontab(text) {
  const result = spawnSync('crontab', ['-'], { input: text, encoding: 'utf8' })
  if (result.error) return { ok: false, reason: result.error.message }
  if (result.status !== 0) return { ok: false, reason: (result.stderr ?? '').trim() || `crontab exited ${result.status}` }
  return { ok: true }
}

/** The crontab without our block, and whether the block was there. */
function stripBlock(text) {
  const lines = text.split('\n')
  const kept = []
  let inside = false
  let found = false
  for (const line of lines) {
    if (line.trim() === BEGIN) {
      inside = true
      found = true
      continue
    }
    if (line.trim() === END) {
      inside = false
      continue
    }
    if (!inside) kept.push(line)
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(), found }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const current = readCrontab()
  if (!current.ok) {
    console.error(`install-cron: ${current.reason}`)
    return 1
  }

  const { text: withoutBlock, found } = stripBlock(current.text)
  const block = desiredBlock()
  const hasWanted = current.text.includes(desiredLine())

  if (args.mode === 'check') {
    console.log('\nHarness Lab — cron check\n')
    console.log(`  schedule   ${SCHEDULE}  (daily)`)
    console.log(`  command    ${desiredLine()}`)
    console.log(`  installed  ${found ? (hasWanted ? 'yes, current' : 'yes, but stale — rerun --install') : 'no'}`)
    if (!found) console.log('\n  run `--install` to add it\n')
    else console.log('')
    return 0
  }

  if (args.mode === 'remove') {
    if (!found) {
      console.log('nothing to remove')
      return 0
    }
    const written = writeCrontab(`${withoutBlock}\n`)
    if (!written.ok) {
      console.error(`install-cron: ${written.reason}`)
      return 1
    }
    console.log('removed the harness-lab sweep entry')
    return 0
  }

  if (hasWanted) {
    console.log('already installed and current')
    return 0
  }
  const next = withoutBlock ? `${withoutBlock}\n\n${block}\n` : `${block}\n`
  const written = writeCrontab(next)
  if (!written.ok) {
    console.error(`install-cron: ${written.reason}`)
    return 1
  }
  console.log('\ninstalled\n')
  console.log(next.trimEnd().split('\n').map((line) => `  ${line}`).join('\n'))
  console.log('\n  remove with: node scripts/install-cron.mjs --remove\n')
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`install-cron failed: ${error.message}`)
  process.exitCode = 1
}
