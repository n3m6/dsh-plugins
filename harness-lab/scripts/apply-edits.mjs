#!/usr/bin/env node
/**
 * Validate, preview, and apply one edit set.
 *
 *   node scripts/apply-edits.mjs --set proposals/h-1.edits.json        # dry run
 *   node scripts/apply-edits.mjs --set proposals/h-1.edits.json --write
 *   node scripts/apply-edits.mjs --revert h-1
 *
 * Dry run is the default. Every edit set is all-or-nothing, every touched file
 * is backed up under backups/<id>/, and the path allowlist below is enforced in
 * code — the proposal's own claim about what it touches is not trusted.
 */
import { lstat, readFile, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  AGENTS_MD_BUDGET,
  diffLines,
  expandHome,
  findSection,
  nowIso,
  paths,
  readJson,
  readText,
  renderDiff,
  resolveTargetPath,
  sha256,
  writeJson,
  writeText,
} from './lib/lab.mjs'
import { loadDigests, measureSignature } from './lib/measure.mjs'

const OPS = new Set(['create', 'replace', 'append-section', 'replace-section', 'delete', 'move'])
/** Kinds that name the friction they address; the rest may omit a signature. */
const SIGNATURE_KINDS = new Set(['add', 'promote', 'demote'])
const DENY_SEGMENTS = new Set(['.git', 'node_modules', 'profiles', 'backups'])
const DENY_NAMES = new Set(['settings.yaml', '.credentials.yaml', 'credentials.yaml', '.env'])

function parseArgs(argv) {
  const args = { set: null, write: false, revert: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--set') args.set = argv[++i]
    else if (arg === '--write') args.write = true
    else if (arg === '--revert') args.revert = argv[++i]
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: apply-edits.mjs --set <file.edits.json> [--write] | --revert <adoption-id>')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!args.set && !args.revert) throw new Error('one of --set or --revert is required')
  return args
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

/** The editable surface. Anything outside it is a bug in the proposal. */
function allowed(path, target) {
  const roots = [
    target,
    expandHome('~/.dsh'),
    expandHome('~/.agents'),
    paths.archive,
  ].filter(Boolean)
  if (!roots.some((root) => within(resolve(root), path))) return false
  const parts = path.split(sep)
  if (parts.some((part) => DENY_SEGMENTS.has(part))) return false
  if (DENY_NAMES.has(basename(path))) return false
  if (basename(path) === 'AGENTS.md') return true
  return (
    path.includes(`${sep}.dsh${sep}skills${sep}`) ||
    path.includes(`${sep}.agents${sep}skills${sep}`) ||
    within(paths.archive, path)
  )
}

async function loadContent(edit, setDir) {
  if (typeof edit.content === 'string') return edit.content
  if (typeof edit.contentFile === 'string') {
    const content = await readText(resolve(setDir, edit.contentFile))
    if (content === null) throw new Error(`contentFile not found: ${edit.contentFile}`)
    return content
  }
  throw new Error(`edit needs content or contentFile: ${edit.file ?? edit.to}`)
}

function applyOp(op, before, edit, content) {
  if (op === 'create' || op === 'replace') return content
  if (op === 'delete') return null
  if (op === 'append-section' || op === 'replace-section') {
    const lines = before.split('\n')
    const section = findSection(lines, edit.section ?? '')
    if (op === 'replace-section') {
      if (!section) throw new Error(`section not found: ## ${edit.section}`)
      const body = content.endsWith('\n') ? content : `${content}\n`
      const merged = [...lines.slice(0, section.start + 1), '', body.trimEnd(), '', ...lines.slice(section.end)]
      return merged.join('\n')
    }
    if (!section) {
      const body = content.trimEnd()
      return `${before.trimEnd()}\n\n## ${edit.section}\n\n${body}\n`
    }
    const body = content.trimEnd()
    const head = lines.slice(0, section.end)
    while (head.length > section.start + 1 && head[head.length - 1].trim() === '') head.pop()
    const merged = [...head, '', body, '', ...lines.slice(section.end)]
    return merged.join('\n').replace(/\n{3,}$/, '\n')
  }
  throw new Error(`unsupported op: ${op}`)
}

/**
 * Validate the signature an edit set targets.
 *
 * A signature is the friction key the digest clusters on — `tool:ErrorClass`,
 * `repeat:tool`, or `compaction`. It is required when the set adds capability
 * (there is then a rate to move) and optional for sets that only prune,
 * compress, or move, which have no single signature to attribute.
 * @returns the trimmed signature, or null when the set does not name one
 */
function signatureOfSet(raw) {
  const signature = raw.signature
  if (signature === undefined || signature === null) {
    if (SIGNATURE_KINDS.has(raw.kind)) {
      throw new Error(`edit set of kind "${raw.kind}" needs a signature`)
    }
    return null
  }
  if (typeof signature !== 'string' || signature.trim() === '') {
    throw new Error('signature must be a non-empty string')
  }
  const trimmed = signature.trim()
  if (/\s/.test(trimmed)) throw new Error(`signature must not contain whitespace: ${signature}`)
  if (trimmed.length > 200) throw new Error('signature is longer than 200 characters')
  return trimmed
}

async function plan(setPath) {
  const raw = JSON.parse(await readFile(setPath, 'utf8'))
  const setDir = dirname(resolve(setPath))
  const target = resolve(expandHome(raw.target ?? '~'))
  if (!raw.id) throw new Error('edit set needs an id')
  if (!Array.isArray(raw.edits) || raw.edits.length === 0) throw new Error('edit set has no edits')
  if (raw.edits.length > 12) throw new Error('edit set exceeds 12 edits')
  const signature = signatureOfSet(raw)

  // Freeze the rate this edit is judged by, before it can affect anything. No
  // digests means "not measured yet", which stays null rather than becoming 0.
  const digests = signature ? await loadDigests(paths.digests) : []
  const baseline = signature && digests.length > 0 ? measureSignature(digests, signature) : null

  const original = new Map() // path -> content before the set touched it (null when absent)
  const working = new Map() // path -> content as of the latest edit
  const steps = []

  const read = async (path) => {
    if (working.has(path)) return working.get(path)
    const content = await readText(path)
    if (!original.has(path)) original.set(path, content)
    return content
  }

  for (const edit of raw.edits) {
    const op = edit.op
    if (!OPS.has(op)) throw new Error(`unsupported op: ${op}`)
    const from = resolveTargetPath(edit.file, target)
    const to = edit.to ? resolveTargetPath(edit.to, target) : null
    for (const path of [from, to].filter(Boolean)) {
      if (!allowed(path, target)) throw new Error(`path outside the editable surface: ${path}`)
    }
    const info = await lstat(from).catch(() => null)
    if (info?.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${from}`)

    const before = await read(from)
    if (op === 'create' && before !== null) throw new Error(`create on existing file: ${from}`)
    if (op !== 'create' && before === null) throw new Error(`missing file: ${from}`)

    if (op === 'move') {
      if (!to) throw new Error(`move needs a destination: ${from}`)
      const destinationBefore = await read(to)
      if (destinationBefore !== null) throw new Error(`move destination exists: ${to}`)
      working.set(to, before)
      working.set(from, null)
      steps.push({ op, file: from, to, before, after: null })
      continue
    }

    const content = op === 'delete' ? null : await loadContent(edit, setDir)
    const after = applyOp(op, before ?? '', edit, content)
    if (basename(from) === 'AGENTS.md' && after && Buffer.byteLength(after) > AGENTS_MD_BUDGET) {
      throw new Error(`AGENTS.md would exceed ${AGENTS_MD_BUDGET} bytes: ${Buffer.byteLength(after)}`)
    }
    working.set(from, after)
    steps.push({ op, file: from, to, section: edit.section ?? null, before, after })
  }

  const files = [...working.entries()].map(([file, final]) => ({
    file,
    original: original.get(file) ?? null,
    final,
  }))
  return { raw, target, signature, baseline, steps, files }
}

function describe(set, steps, baseline) {
  console.log(`\nHarness Lab — edit set ${set.id}`)
  console.log(`  scope     ${set.scope ?? '(unset)'}   kind ${set.kind ?? '(unset)'}   class ${set.class ?? '(unset)'}`)
  console.log(`  target    ${set.target ?? '(home)'}`)
  console.log(`  dimension ${set.dimension ?? '(unset)'}`)
  if (set.signature) console.log(`  signature ${set.signature}`)
  if (baseline) {
    console.log(`  baseline  ${baseline.sessions} session(s), ${baseline.hits} hit(s) across the current digests`)
  } else if (set.signature) {
    console.log('  baseline  none — no digests yet, this adoption cannot be measured until one runs')
  }
  if (set.evidence) console.log(`  evidence  ${[].concat(set.evidence).join(', ')}`)
  for (const step of steps) {
    const label =
      step.op === 'delete'
        ? `delete ${step.file}`
        : step.op === 'move'
          ? `move ${step.file} → ${step.to}`
          : `${step.op} ${step.file}`
    console.log(`\n  ${label}`)
    if (step.op === 'delete' || step.op === 'move') {
      console.log(`    (${(step.before ?? '').split('\n').length} lines removed)`)
      continue
    }
    const before = step.before ?? ''
    if (!before) {
      console.log(`    + new file, ${step.after.split('\n').length} lines, ${Buffer.byteLength(step.after)} bytes`)
      continue
    }
    console.log(renderDiff(diffLines(before, step.after)))
  }
}

async function writePlan(set, steps, files, signature, baseline) {
  const adoptionId = set.id
  const adoptionPath = join(paths.adoptions, `${adoptionId}.json`)
  const prior = await readJson(adoptionPath, null)
  if (prior && !prior.revertedAt) throw new Error(`already adopted: ${adoptionId}`)

  const backupDir = join(paths.backups, adoptionId)
  const record = {
    id: adoptionId,
    at: nowIso(),
    set: { kind: set.kind, scope: set.scope, class: set.class, dimension: set.dimension },
    target: set.target ?? null,
    signature,
    baseline,
    evidence: [].concat(set.evidence ?? []),
    rationale: set.rationale ?? null,
    files: [],
    revertedAt: null,
  }

  for (const [index, entry] of files.entries()) {
    if (entry.original !== null) await writeText(join(backupDir, `${index}.bak`), entry.original)
    record.files.push({
      index,
      file: entry.file,
      existedBefore: entry.original !== null,
      deleted: entry.final === null,
      beforeHash: entry.original === null ? null : sha256(entry.original),
      afterHash: entry.final === null ? null : sha256(entry.final),
    })
  }

  for (const entry of files) {
    if (entry.final === null) await unlink(entry.file)
    else await writeText(entry.file, entry.final)
  }

  await writeJson(adoptionPath, record)
  await appendExperience(set, files.length)
  return record
}

async function appendExperience(set, count) {
  const parts = [
    `- ${nowIso().slice(0, 10)}`,
    `\`${set.id}\``,
    set.kind ?? 'add',
    set.scope ?? 'project',
    `dimension \`${set.dimension ?? 'unset'}\``,
  ]
  if (set.signature) parts.push(`signature \`${set.signature}\``)
  parts.push(`${count} file(s)`, `**pending** — ${(set.rationale ?? '').split('\n')[0].trim()}`)
  const existing = (await readText(paths.experience)) ?? '# Experience\n\nAppend-only record of what the harness lab tried and what happened.\n'
  await writeText(paths.experience, `${existing.trimEnd()}\n${parts.join(' · ')}\n`)
}

async function revert(id) {
  const record = await readJson(join(paths.adoptions, `${id}.json`), null)
  if (!record) throw new Error(`no adoption record: ${id}`)
  if (record.revertedAt) throw new Error(`already reverted: ${id}`)

  for (const entry of [...record.files].reverse()) {
    if (entry.existedBefore) {
      const backup = await readText(join(paths.backups, id, `${entry.index}.bak`))
      if (backup === null) throw new Error(`backup missing for ${entry.file}`)
      await writeText(entry.file, backup)
    } else {
      await rm(entry.file, { force: true })
      // Drop directories this edit created, up to but never including the skills root.
      let dir = dirname(entry.file)
      while (!/(^|\/)(\.dsh|\.agents)$/.test(dir) && !dir.endsWith('/skills')) {
        try {
          await rmdir(dir)
        } catch {
          break
        }
        dir = dirname(dir)
      }
    }
  }
  record.revertedAt = nowIso()
  await writeJson(join(paths.adoptions, `${id}.json`), record)
  console.log(`reverted ${id} (${record.files.length} files)`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.revert) return revert(args.revert)

  const { raw, steps, files, signature, baseline } = await plan(args.set)
  describe(raw, steps, baseline)
  if (!args.write) {
    console.log('\n  dry run — nothing written. Re-run with --write to apply.\n')
    return
  }
  try {
    const record = await writePlan(raw, steps, files, signature, baseline)
    console.log(`\n  applied ${record.id} (${record.files.length} files), backups in backups/${record.id}/\n`)
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      console.error(
        `\n  permission denied writing ${error.path ?? 'target'}.\n  The target is outside the writable workspace: approve the escalation or run this script in a normal shell.\n`,
      )
      process.exit(2)
    }
    throw error
  }
}

main().catch((error) => {
  console.error(`apply-edits failed: ${error.message}`)
  process.exit(1)
})
