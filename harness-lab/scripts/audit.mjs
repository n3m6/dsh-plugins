#!/usr/bin/env node
/**
 * Monthly rebalancing pass: prune, demote, promote, compress.
 *
 *   node scripts/harness.mjs audit
 *   node scripts/harness.mjs audit --since 90 --json
 *   node scripts/harness.mjs audit --strict      # exit 1 when anything is actionable
 *
 * This is a *report*, not an edit. It reads the skill roots and the digests,
 * and it never writes: every candidate still goes through a proposal, a diff,
 * and an approval. The rules are SPEC §11; the honesty constraints in
 * `caveats()` matter as much as the rules, because a skill root with no
 * recorded invocations is evidence of absence, not proof of uselessness.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { AGENTS_MD_BUDGET, expandHome, paths, sha256 } from './lib/lab.mjs'
import { loadDigests } from './lib/measure.mjs'

const DAY = 86_400_000
const PRUNE_AGE_DAYS = 60
const COMPRESS_RATIO = 0.75
const SKILL_FILE = 'SKILL.md'
const MAX_ROOT_WALK = 10

function parseArgs(argv) {
  const args = { since: 90, now: null, json: false, strict: false, all: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--since') args.since = Number(argv[++i]) || 90
    else if (arg === '--now') args.now = argv[++i]
    else if (arg === '--json') args.json = true
    else if (arg === '--strict') args.strict = true
    else if (arg === '--all') args.all = true
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: audit.mjs [--since DAYS] [--now ISO] [--json] [--strict] [--all]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/** The two user roots, in the order the skill provider ranks them. */
function userRoots() {
  const agentsHome = resolve(expandHome(process.env.AGENTS_HOME ?? join(homedir(), '.agents')))
  const dshHome = resolve(expandHome(process.env.DSH_HOME ?? join(homedir(), '.dsh')))
  return [
    { kind: 'user', dir: join(agentsHome, 'skills') },
    { kind: 'user', dir: join(dshHome, 'skills') },
  ]
}

/**
 * Walk up from a session cwd to its project root.
 *
 * The skill provider resolves project roots the same way, so a session started
 * in a subdirectory must still find `<root>/.dsh/skills`. `.git` is the marker;
 * a directory without one is treated as its own root, which is what every
 * fixture and every scratch directory is.
 */
async function projectRootOf(cwd) {
  let dir = resolve(cwd)
  for (let depth = 0; depth < MAX_ROOT_WALK; depth += 1) {
    const marker = await stat(join(dir, '.git')).catch(() => null)
    if (marker) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(cwd)
}

async function projectRoots(digests) {
  const seen = new Set()
  const roots = []
  for (const digest of digests) {
    if (!digest.cwd) continue
    const root = await projectRootOf(digest.cwd)
    if (seen.has(root)) continue
    seen.add(root)
    roots.push(root)
  }
  return roots
}

/** Read `name` and `description` out of a SKILL.md frontmatter block. */
function frontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!block) return {}
  const name = /^name:\s*(.+)$/m.exec(block[1])
  const description = /^description:\s*(.+)$/m.exec(block[1])
  return {
    name: name ? name[1].trim().replace(/^["']|["']$/g, '') : undefined,
    description: description ? description[1].trim() : undefined,
  }
}

/**
 * List the skills under one root as directory bundles (`<name>/SKILL.md`) or
 * flat files (`<name>.md`), which are the two shapes the provider discovers.
 */
async function scanRoot(root, nowMs, references) {
  const entries = await readdir(root.dir, { withFileTypes: true }).catch(() => [])
  const skills = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    let file = null
    if (entry.isDirectory()) {
      file = join(root.dir, entry.name, SKILL_FILE)
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== SKILL_FILE) {
      file = join(root.dir, entry.name)
    }
    if (!file) continue

    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    const info = await stat(file).catch(() => null)
    if (!info) continue
    const meta = frontmatter(text)
    const name = meta.name ?? basename(file, '.md')

    references.push({ name, text, file })
    skills.push({
      name,
      kind: root.kind,
      root: root.dir,
      file,
      hash: sha256(text),
      ageDays: Math.max(0, Math.round((nowMs - info.mtimeMs) / DAY)),
    })
  }
  return skills
}

/**
 * Invocations per skill inside the window.
 *
 * `metrics.skillInvocations` is an exact count taken from the `skill` tool calls
 * during the digest's single pass. It is deliberately not derived from
 * `signatures.json`, whose stored moments are capped at three per session and
 * therefore undercount.
 */
function invocationIndex(digests, sinceMs) {
  const uses = new Map()
  let sessions = 0
  const projects = new Set()
  for (const digest of digests) {
    const startedAt = digest.startedAt ? Date.parse(digest.startedAt) : Number.NaN
    if (Number.isFinite(startedAt) && startedAt < sinceMs) continue
    sessions += 1
    if (digest.cwd) projects.add(digest.cwd)
    for (const [skill, count] of Object.entries(digest.metrics?.skillInvocations ?? {})) {
      const entry = uses.get(skill) ?? { count: 0, projects: new Set() }
      entry.count += count
      if (digest.cwd) entry.projects.add(digest.cwd)
      uses.set(skill, entry)
    }
  }
  return { uses, sessions, projects: projects.size }
}

/** True when the skill name appears in some other skill or AGENTS.md text. */
function referencedElsewhere(name, references, self) {
  const needle = new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`)
  return references.some((entry) => entry.file !== self && needle.test(entry.text))
}

async function agentFiles(roots) {
  const files = []
  for (const root of roots) {
    for (const candidate of ['AGENTS.md', 'CLAUDE.md']) {
      const file = join(root, candidate)
      const info = await stat(file).catch(() => null)
      if (info?.isFile()) files.push({ file, bytes: info.size })
    }
  }
  return files
}

function formatBytes(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

async function audit({ since, now }) {
  const nowMs = now ? Date.parse(now) : Date.now()
  if (!Number.isFinite(nowMs)) throw new Error(`--now is not a date: ${now}`)
  const sinceMs = nowMs - since * DAY
  const digests = await loadDigests(paths.digests)

  const roots = [...userRoots()]
  const projects = await projectRoots(digests)
  for (const project of projects) {
    roots.push({ kind: 'project', dir: join(project, '.dsh', 'skills') })
    roots.push({ kind: 'project', dir: join(project, '.agents', 'skills') })
  }

  const references = []
  const skills = []
  const scanned = []
  for (const root of roots) {
    const found = await scanRoot(root, nowMs, references)
    scanned.push({ kind: root.kind, dir: root.dir, skills: found.length })
    skills.push(...found)
  }

  const { uses, sessions, projects: projectCount } = invocationIndex(digests, sinceMs)
  for (const skill of skills) {
    const entry = uses.get(skill.name)
    skill.uses = entry?.count ?? 0
    skill.projects = entry ? [...entry.projects] : []
  }

  const candidates = { prune: [], demote: [], promote: [], compress: [] }

  // Prune and demote both rest on invocations. When the corpus records none at
  // all, the `skill` tool was simply never called, and every rule keyed on usage
  // would fire against every skill. Suppressing is the honest answer.
  const anySkillUse = [...uses.values()].some((entry) => entry.count > 0)

  if (anySkillUse) {
    for (const skill of skills) {
      const shared = referencedElsewhere(skill.name, references, skill.file)
      if (skill.ageDays > PRUNE_AGE_DAYS && skill.uses === 0 && !shared) {
        candidates.prune.push({ ...skill, reason: `no invocation in ${since}d, ${skill.ageDays}d old, unreferenced` })
      }
    }

    for (const skill of skills) {
      if (skill.kind === 'user' && skill.uses > 0 && skill.projects.length === 1) {
        candidates.demote.push({ ...skill, reason: `user skill used from one project only (${skill.projects[0]})` })
      }
    }
  }

  const byName = new Map()
  for (const skill of skills.filter((entry) => entry.kind === 'project')) {
    const group = byName.get(skill.name) ?? []
    group.push(skill)
    byName.set(skill.name, group)
  }
  for (const [name, group] of byName) {
    if (group.length < 2) continue
    const hashes = new Set(group.map((entry) => entry.hash))
    const roots = [...new Set(group.map((entry) => entry.root))]
    candidates.promote.push({
      name,
      roots,
      uses: group.reduce((sum, entry) => sum + entry.uses, 0),
      copies: group.length,
      variants: hashes.size,
      reason:
        hashes.size === 1
          ? `${group.length} byte-identical copies under ${roots.length} project roots — promote one`
          : `${group.length} copies under ${roots.length} project roots in ${hashes.size} variants — merges first`,
    })
  }

  const agentsFiles = await agentFiles(projects)
  const globalAgents = join(resolve(expandHome(process.env.DSH_HOME ?? join(homedir(), '.dsh'))), 'AGENTS.md')
  const globalInfo = await stat(globalAgents).catch(() => null)
  if (globalInfo?.isFile()) agentsFiles.push({ file: globalAgents, bytes: globalInfo.size })

  for (const entry of agentsFiles) {
    const share = entry.bytes / AGENTS_MD_BUDGET
    if (share > COMPRESS_RATIO) {
      candidates.compress.push({ ...entry, share: Number(share.toFixed(3)), reason: `${(share * 100).toFixed(0)}% of the ${AGENTS_MD_BUDGET}-byte budget` })
    }
  }

  const unknownUses = [...uses.keys()].filter((name) => !skills.some((skill) => skill.name === name)).sort()
  const userSkills = skills.filter((skill) => skill.kind === 'user')

  const caveats = [
    `Absence means no recorded invocation in the ${since}-day window, not that a skill is unused.`,
  ]
  if (sessions === 0) caveats.push('The window contains no sessions: this run is not evidence about usage at all.')
  if (!anySkillUse) {
    caveats.push(
      'The `skill` tool was never invoked in this corpus, so every use count is zero. Prune and demote are suppressed: they would otherwise flag every skill as unused.',
    )
  }
  if (anySkillUse && userSkills.length > 0 && userSkills.every((skill) => skill.uses === 0)) {
    caveats.push(
      `All ${userSkills.length} user-root skills are unused by these ${sessions} session(s). If they serve another domain than this corpus, that is not a prune signal — judge before acting.`,
    )
  }
  if (unknownUses.length > 0) {
    caveats.push(`${unknownUses.length} invoked name(s) are not in any scanned root (plugin-provided?): ${unknownUses.join(', ')}`)
  }

  return {
    at: new Date(nowMs).toISOString(),
    windowDays: since,
    corpus: { sessions, projects: projectCount },
    roots: scanned,
    skills,
    candidates,
    caveats,
  }
}

function render(report, { all }) {
  const lines = []
  const pad = (text, width) => String(text).padEnd(width)

  lines.push(`\nHarness Lab — audit  ${report.at}`)
  lines.push(`  window        ${report.windowDays} days`)
  lines.push(`  corpus        ${report.corpus.sessions} session(s) across ${report.corpus.projects} project(s) in window`)
  lines.push('  roots')
  const populated = report.roots.filter((root) => root.skills > 0)
  const empty = report.roots.length - populated.length
  if (!populated.length) lines.push('    — no root contains a skill')
  for (const root of populated) {
    lines.push(`    ${pad(root.kind, 8)} ${pad(root.skills, 3)}  ${root.dir}`)
  }
  if (empty > 0) lines.push(`    ${'—'.padEnd(8)} ${empty} empty root(s) not shown`)

  const shown = all ? report.skills : report.skills.slice(0, 20)
  lines.push('\n  skills')
  if (shown.length === 0) lines.push('    — none found in any scanned root')
  else {
    lines.push(`    ${pad('NAME', 28)} ${pad('ROOT', 8)} ${pad('AGE', 5)} ${pad('USES', 5)} PROJECTS`)
    for (const skill of shown) {
      const where = skill.projects.length ? `${skill.projects.length}` : '—'
      lines.push(`    ${pad(skill.name, 28)} ${pad(skill.kind, 8)} ${pad(`${skill.ageDays}d`, 5)} ${pad(skill.uses, 5)} ${where}`)
    }
    if (shown.length < report.skills.length) lines.push(`    … ${report.skills.length - shown.length} more (--all)`)
  }

  const { prune, demote, promote, compress } = report.candidates
  lines.push('\n  candidates')
  if (!prune.length && !demote.length && !promote.length && !compress.length) {
    lines.push('    — none. Nothing is old enough, duplicated, over budget, or used from a single project.')
  }
  for (const item of prune) lines.push(`    prune     ${pad(item.name, 26)} ${item.root}  — ${item.reason}`)
  for (const item of demote) lines.push(`    demote    ${pad(item.name, 26)} ${item.root}  — ${item.reason}`)
  for (const item of promote) lines.push(`    promote   ${pad(item.name, 26)} ${item.roots.join(', ')}  — ${item.reason}`)
  for (const item of compress) lines.push(`    compress  ${formatBytes(item.bytes)} ${item.file}  — ${item.reason}`)

  lines.push('\n  notes')
  for (const caveat of report.caveats) lines.push(`    · ${caveat}`)
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const report = await audit(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(render(report, { all: args.all }))

  if (!args.json) {
    const total = Object.values(report.candidates).reduce((sum, list) => sum + list.length, 0)
    console.log(`\n  ${total} candidate(s). Nothing is applied here; each needs a proposal and an approval.\n`)
  }
  if (args.strict) {
    const total = Object.values(report.candidates).reduce((sum, list) => sum + list.length, 0)
    return total > 0 ? 1 : 0
  }
  return 0
}

process.exit(await main())
