#!/usr/bin/env node
/**
 * Install the `harness-improve` skill where every session can discover it.
 *
 *   node scripts/install.mjs            # report only (default)
 *   node scripts/install.mjs --install
 *   node scripts/install.mjs --uninstall
 *
 * DSH's filesystem skill provider scans project roots and then the user roots
 * `$DSH_HOME/skills` and `$AGENTS_HOME/skills`. This skill is meant to follow
 * you across projects, so it belongs in the agents home: `$AGENTS_HOME/skills`,
 * falling back to `~/.agents/skills`.
 *
 * A symlink keeps one copy of the truth: edit the skill in this checkout and
 * every session sees the change. Where symlinks are refused (some sandboxes and
 * Windows setups), a copy carrying a marker file is installed instead, and the
 * report says which happened.
 */
import { cp, lstat, mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const CODE_ROOT = dirname(SCRIPTS)
const SOURCE = join(CODE_ROOT, 'skills', 'harness-improve')
const SOURCE_SKILL = join(SOURCE, 'SKILL.md')
const MARKER = '.harness-lab-install'

/** Resolved per call so a test can redirect the whole install with AGENTS_HOME. */
function locations() {
  const agentsHome = process.env.AGENTS_HOME
    ? resolve(process.env.AGENTS_HOME)
    : join(homedir(), '.agents')
  const root = join(agentsHome, 'skills')
  return { agentsHome, root, target: join(root, 'harness-improve') }
}

function okay(label, detail) {
  console.log(`  ${label.padEnd(14)} ok      ${detail}`)
}

function problem(label, detail) {
  console.log(`  ${label.padEnd(14)} FAIL    ${detail}`)
}

/** Minimal YAML frontmatter: the two fields the skill catalog needs. */
function frontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!block) return null
  const fields = {}
  for (const line of block[1].split('\n')) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (pair) fields[pair[1]] = pair[2].trim()
  }
  return fields
}

async function inspectTarget(target) {
  const info = await lstat(target).catch(() => null)
  if (!info) return { kind: 'absent' }
  if (info.isSymbolicLink()) {
    const link = await readlink(target)
    const resolved = resolve(dirname(target), link)
    return resolved === resolve(SOURCE) ? { kind: 'link', resolved } : { kind: 'link-elsewhere', resolved }
  }
  if (info.isDirectory()) {
    const marked = await lstat(join(target, MARKER)).then(
      () => true,
      () => false,
    )
    return marked ? { kind: 'copy' } : { kind: 'foreign' }
  }
  return { kind: 'foreign' }
}

function discoveryNote() {
  console.log(
    '\n  discovery  a new session lists skills from project roots, then $DSH_HOME/skills\n' +
      '             and $AGENTS_HOME/skills. The first prompt\'s skill list is the way to\n' +
      '             confirm it took effect; installation alone does not prove discovery.',
  )
}

async function check() {
  const { agentsHome, root, target } = locations()
  const state = await inspectTarget(target)
  let healthy = true

  console.log('\nHarness Lab — install check\n')
  console.log(`  ${'cwd'.padEnd(14)} ${process.cwd()}`)
  okay('code root', CODE_ROOT)
  okay('state dir', `${process.env.HARNESS_LAB_DIR ?? CODE_ROOT}${process.env.HARNESS_LAB_DIR ? ' (HARNESS_LAB_DIR)' : ''}`)
  okay('resolves', 'every path derives from the code root, so the cwd does not matter')

  const dispatcher = join(SCRIPTS, 'harness.mjs')
  const dispatcherOk = await lstat(dispatcher).then(
    (info) => info.isFile(),
    () => false,
  )
  if (dispatcherOk) okay('dispatcher', relative(CODE_ROOT, dispatcher))
  else {
    problem('dispatcher', `${dispatcher} is missing`)
    healthy = false
  }

  const skillText = await readFile(SOURCE_SKILL, 'utf8').catch(() => null)
  if (skillText === null) {
    problem('skill source', `${SOURCE_SKILL} is missing`)
    healthy = false
  } else {
    const fields = frontmatter(skillText)
    if (fields?.name && fields?.description) {
      okay('skill source', `frontmatter name=${fields.name}, ${skillText.split('\n').length} lines`)
    } else {
      problem('skill source', 'frontmatter needs both name and description')
      healthy = false
    }
  }

  okay('agents home', agentsHome)
  if (state.kind === 'link') okay('install', `symlink → ${state.resolved}`)
  else if (state.kind === 'copy') okay('install', `copy in ${target} (marker present)`)
  else if (state.kind === 'absent') console.log(`  ${'install'.padEnd(14)} absent  not installed — run --install`)
  else {
    problem('install', `${target} exists and is not from this checkout (${state.resolved ?? 'real directory'})`)
    healthy = false
  }

  discoveryNote()
  console.log(`\n  ${healthy ? 'ready' : 'needs attention'}\n`)
  return healthy ? 0 : 1
}

async function install() {
  const { agentsHome, root, target } = locations()
  await mkdir(root, { recursive: true })
  const state = await inspectTarget(target)

  if (state.kind === 'link' || state.kind === 'copy') {
    console.log(`\n  already installed: ${target}`)
    discoveryNote()
    return 0
  }
  if (state.kind === 'link-elsewhere' || state.kind === 'foreign') {
    console.error(`\n  refusing to overwrite ${target}: it is not from this checkout\n`)
    return 1
  }

  let method = 'symlink'
  try {
    await symlink(SOURCE, target, 'dir')
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EEXIST'].includes(error.code)) throw error
    await cp(SOURCE, target, { recursive: true })
    await writeFile(join(target, MARKER), `${SOURCE}\n${new Date().toISOString()}\n`)
    method = 'copy'
  }

  console.log(`\n  installed ${target}`)
  console.log(`  method    ${method === 'symlink' ? `symlink → ${SOURCE}` : 'copy (symlinks refused here; re-run --install after editing the skill)'}`)
  console.log(`  agents    ${agentsHome}`)
  discoveryNote()
  return 0
}

async function uninstall() {
  const { target } = locations()
  const state = await inspectTarget(target)
  if (state.kind === 'absent') {
    console.log('\n  nothing installed\n')
    return 0
  }
  if (state.kind === 'link') {
    await unlink(target)
    console.log(`\n  removed symlink ${target}\n`)
    return 0
  }
  if (state.kind === 'copy') {
    await rm(target, { recursive: true, force: true })
    console.log(`\n  removed copy ${target}\n`)
    return 0
  }
  console.error(`\n  refusing to remove ${target}: it was not installed by this script\n`)
  return 1
}

async function main(argv) {
  const flags = new Set(argv)
  const known = ['--check', '--install', '--uninstall', '--help', '-h']
  const unknown = argv.filter((arg) => !known.includes(arg))
  if (unknown.length) {
    console.error(`install: unknown argument ${unknown[0]}`)
    return 2
  }
  if (flags.has('--help') || flags.has('-h')) {
    console.log('Usage: install.mjs [--check | --install | --uninstall]')
    return 0
  }
  if (flags.has('--install')) return install()
  if (flags.has('--uninstall')) return uninstall()
  return check()
}

process.exit(await main(process.argv.slice(2)))
