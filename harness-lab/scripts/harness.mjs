#!/usr/bin/env node
/**
 * One entry point for every lab command, usable from any directory.
 *
 *   node /path/to/harness-lab/scripts/harness.mjs status
 *   node scripts/harness.mjs digest --since 7
 *
 * This is a dispatcher and nothing else: it picks a script, forwards the
 * remaining arguments verbatim, and hands the child's streams and exit code
 * straight back. Anything that needs to parse arguments lives in the script it
 * names, so there is exactly one definition of each command's interface.
 *
 * `reject` and `unreject` are sugar for `apply-edits.mjs --reject|--unreject`:
 * a bare first argument becomes that flag, so `harness.mjs reject <key>` and
 * `harness.mjs reject --reject <key>` both work.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))

const COMMANDS = [
  { name: 'digest', script: 'digest.mjs', summary: 'cluster friction signatures from session logs' },
  { name: 'evidence', script: 'evidence.mjs', summary: 'the calls around every occurrence of a signature' },
  { name: 'apply', script: 'apply-edits.mjs', summary: 'diff, validate, apply, or revert an edit set' },
  { name: 'reject', script: 'apply-edits.mjs', flag: '--reject', summary: 'silence a signature for 90 days' },
  { name: 'unreject', script: 'apply-edits.mjs', flag: '--unreject', summary: 'lift a rejection early' },
  { name: 'watch', script: 'watch.mjs', summary: 're-measure adoptions and resolve them' },
  { name: 'status', script: 'status.mjs', summary: 'adoptions, rejections, and drift in one screen' },
  { name: 'audit', script: 'audit.mjs', summary: 'monthly prune / promote / demote pass' },
  { name: 'sweep', script: 'sweep.mjs', summary: 'unattended digest + watch + status, for cron' },
  { name: 'cron', script: 'install-cron.mjs', summary: 'check, install, or remove the sweep crontab entry' },
  { name: 'selftest', script: 'selftest.mjs', summary: 'check the lab against a throwaway fixture' },
]

function help() {
  const width = Math.max(...COMMANDS.map((command) => command.name.length))
  console.log('Harness Lab — commands\n')
  for (const command of COMMANDS) {
    console.log(`  ${command.name.padEnd(width)}  ${command.summary}`)
  }
  console.log('\nAny arguments after the command go to it unchanged.')
  console.log('Example: node scripts/harness.mjs digest --since 7 --json\n')
}

function main(argv) {
  const [name, ...rest] = argv
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    help()
    return 0
  }

  const command = COMMANDS.find((entry) => entry.name === name)
  if (!command) {
    console.error(`harness: unknown command "${name}"\n`)
    help()
    return 2
  }

  const script = join(SCRIPTS, command.script)
  if (!existsSync(script)) {
    console.error(`harness: "${name}" is not implemented yet (${command.script} is missing)`)
    return 2
  }

  const args = command.flag && rest[0] && !rest[0].startsWith('-') ? [command.flag, ...rest] : rest
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })
  if (result.error) {
    console.error(`harness: could not run ${command.script}: ${result.error.message}`)
    return 1
  }
  // A child killed by a signal reports a null status; treat that as failure.
  return result.status ?? 1
}

process.exit(main(process.argv.slice(2)))
