/**
 * Shared helpers for the harness lab: paths, JSON I/O, text, and a small diff.
 * No external dependencies — this runs as plain `node` outside the DSH loader.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// .../harness-lab/scripts/lib/lab.mjs -> harness-lab
export const LAB = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export const paths = {
  root: LAB,
  digests: join(LAB, 'digests'),
  proposals: join(LAB, 'proposals'),
  backups: join(LAB, 'backups'),
  adoptions: join(LAB, 'adoptions'),
  runs: join(LAB, 'runs'),
  archive: join(LAB, 'archive'),
  index: join(LAB, 'index.json'),
  signatures: join(LAB, 'signatures.json'),
  experience: join(LAB, 'EXPERIENCE.md'),
  rejections: join(LAB, 'rejections.json'),
}

export const AGENTS_MD_BUDGET = 65536

export function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export function resolveTargetPath(file, target) {
  const expanded = expandHome(file)
  return resolve(expanded.startsWith('/') ? expanded : join(target ?? '.', expanded))
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) throw new Error(`${file}: invalid JSON — ${error.message}`)
    throw error
  }
}

export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(tmp, file)
}

export async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function writeText(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, file)
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function nowIso() {
  return new Date().toISOString()
}

export function stamp() {
  return nowIso().replace(/[-:]/g, '').replace(/\..+$/, '')
}

/** Section boundaries for a Markdown heading, by heading text. */
export function findSection(lines, heading) {
  const wanted = heading.replace(/^#+\s*/, '').trim().toLowerCase()
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[i])
    if (!match) continue
    if (match[2].trim().toLowerCase() !== wanted) continue
    const level = match[1].length
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = /^(#{1,6})\s+/.exec(lines[j])
      if (next && next[1].length <= level) {
        end = j
        break
      }
    }
    return { start: i, end, level }
  }
  return null
}

/** Minimal LCS line diff, adequate for AGENTS.md and skill files. */
export function diffLines(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    return [{ op: '~', text: `(${n} lines → ${m} lines; too large to diff inline)` }]
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: '-', text: a[i] })
      i += 1
    } else {
      out.push({ op: '+', text: b[j] })
      j += 1
    }
  }
  while (i < n) out.push({ op: '-', text: a[i++] })
  while (j < m) out.push({ op: '+', text: b[j++] })
  return out
}

/** Render a diff with 2 lines of context around each change. */
export function renderDiff(diff, context = 2) {
  const keep = new Set()
  diff.forEach((line, index) => {
    if (line.op === ' ') return
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k += 1) {
      keep.add(k)
    }
  })
  const out = []
  let lastKept = -2
  diff.forEach((line, index) => {
    if (!keep.has(index)) return
    if (index !== lastKept + 1) out.push('  …')
    lastKept = index
    out.push(`  ${line.op} ${line.text}`)
  })
  return out.join('\n')
}

export function pct(value) {
  return `${(value * 100).toFixed(1)}%`
}

export function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
