#!/usr/bin/env node
/**
 * Show what actually happens around a friction signature.
 *
 *   node scripts/evidence.mjs --signature edit:FsError/FS_NOT_OBSERVED
 *   node scripts/evidence.mjs --signature repeat:bash --context 5 --limit 10
 *   node scripts/evidence.mjs --signature compaction --json
 *
 * The digest keeps only three moments per session, which is enough to rank
 * friction and far too little to explain it. This reads the real session logs
 * instead, prints the calls that preceded each occurrence, and reports an
 * aggregate over every occurrence in scope — so a pattern like "122 of 124 were
 * preceded by a bash command touching the same file" is visible without reading
 * each block.
 *
 * The aggregate answers two different questions and keeps them apart:
 * `touchedBy` asks whether any earlier call in the session referenced the file
 * the failing call targeted; `immediatelyBefore` asks what ran just before.
 * Only the first one is evidence about a mechanism.
 */
import { basename, resolve } from 'node:path'
import { expandHome } from './lib/lab.mjs'
import { listSessionFiles, readSession, resultText } from './lib/sessions.mjs'

const DEFAULT_LIMIT = 5
const DEFAULT_CONTEXT = 3
const CLIP = 96
/** Calls that change a file's observed version, and so end an observation epoch. */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** Split a signature key into the family the scanner must look for. */
export function parseSignature(key) {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('--signature is required')
  if (key === 'compaction') return { key, family: 'compaction' }
  if (key.startsWith('repeat:')) {
    const tool = key.slice('repeat:'.length)
    if (!tool) throw new Error(`repeat signature needs a tool name: ${key}`)
    return { key, family: 'repeat', tool }
  }
  const split = key.indexOf(':')
  if (split < 1) throw new Error(`unrecognised signature: ${key} (expected tool:ErrorClass, repeat:tool, or compaction)`)
  return { key, family: 'error', tool: key.slice(0, split), error: key.slice(split + 1) }
}

function parseArgs(argv) {
  const args = { signature: null, limit: DEFAULT_LIMIT, context: DEFAULT_CONTEXT, since: null, project: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--signature') args.signature = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--context') args.context = Number(argv[++i])
    else if (arg === '--since') args.since = Number(argv[++i])
    else if (arg === '--project') args.project = resolve(expandHome(argv[++i]))
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: evidence.mjs --signature <key> [--limit N] [--context K] [--since DAYS] [--project DIR] [--json]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!args.signature) throw new Error('--signature is required')
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer')
  if (!Number.isInteger(args.context) || args.context < 0) throw new Error('--context must be a non-negative integer')
  return args
}

function clip(text, max = CLIP) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function argsOf(raw) {
  try {
    return JSON.parse(raw ?? '{}')
  } catch {
    return {}
  }
}

function targetOf(call) {
  const args = argsOf(call.raw)
  return args.path ?? args.file_path ?? args.filePath ?? null
}

function shortId(id) {
  return String(id ?? '?').replace(/^session-/, '').slice(0, 8)
}

/**
 * Walk one session and collect occurrences of one signature.
 *
 * Aggregate counting happens here, against the live prefix of calls, because
 * keeping every occurrence's full history would mean holding the whole session
 * in memory once per hit.
 */
function scanSession(session, parsed, context, limit) {
  const shown = []
  const touchedBy = new Map()
  const immediatelyBefore = new Map()
  let occurrences = 0
  let targetsKnown = 0

  const peers = []
  const callById = new Map()
  let previousKey = null

  const project = session.cwd ? basename(session.cwd) : '(unknown)'

  const record = (call, index, detail) => {
    occurrences += 1
    const target = call ? targetOf(call) : null
    if (target) {
      targetsKnown += 1
      const name = basename(target)
      // A successful write ends the epoch: the version the model saw is gone, and
      // any earlier read no longer counts. Only calls after that point are evidence.
      let epoch = 0
      for (let i = index - 1; i >= 0; i -= 1) {
        const peer = peers[i]
        if (peer.ok === true && WRITE_TOOLS.has(peer.name) && targetOf(peer) === target) {
          epoch = i + 1
          break
        }
      }
      const seen = new Set()
      for (let i = epoch; i < index; i += 1) {
        const peer = peers[i]
        // Only a call that actually succeeded can have registered an observation,
        // so a failed read is not evidence that the file was seen.
        if (peer.ok !== true) continue
        const matches = peer.name === 'read' ? targetOf(peer) === target : peer.raw.includes(name)
        if (matches) seen.add(peer.name)
      }
      for (const tool of seen) touchedBy.set(tool, (touchedBy.get(tool) ?? 0) + 1)
    }
    const previous = index > 0 ? peers[index - 1] : null
    if (previous) immediatelyBefore.set(previous.name, (immediatelyBefore.get(previous.name) ?? 0) + 1)

    if (shown.length >= limit) return
    shown.push({
      sessionId: session.id,
      project,
      step: detail.step ?? null,
      target,
      before: peers.slice(Math.max(0, index - context), index).map((peer) => ({ name: peer.name, args: clip(peer.raw, 140) })),
      call: call ? { name: call.name, args: clip(call.raw, 140) } : null,
      error: detail.error ?? null,
      snippet: detail.snippet ?? null,
    })
  }

  for (const event of session.events) {
    if (event.type === 'compaction/start') {
      if (parsed.family === 'compaction') record(null, peers.length, { step: null })
      continue
    }
    if (event.type === 'tool/call') {
      const name = event.data?.name ?? 'unknown'
      const raw = event.data?.arguments ?? ''
      const call = { name, raw, ok: undefined }
      callById.set(event.data?.callId, call)
      const key = `${name}|${raw}`.slice(0, 400)
      if (parsed.family === 'repeat' && parsed.tool === name && previousKey === key) {
        record(call, peers.length, { step: event.data?.step ?? null })
      }
      previousKey = key
      peers.push(call)
      continue
    }
    if (event.type === 'tool/result' && parsed.family === 'error') {
      const resolved = callById.get(event.data?.message?.source?.callId)
      if (resolved) resolved.ok = !event.data?.error
      if (!event.data?.error) continue

      const call = resolved
      if (!call) continue
      const error = event.data.error
      const key = `${call.name}:${error.name ?? 'Error'}/${error.code ?? 'UNKNOWN'}`
      if (key !== parsed.key) continue
      const index = peers.findIndex((peer) => peer === call)
      if (index < 0) continue
      record(call, index, {
        step: event.data?.turn !== undefined ? event.data?.step ?? null : null,
        error: key,
        snippet: clip(resultText(event).replace(/^Error:\s*/, ''), 140),
      })
    }
  }

  return { shown, occurrences, targetsKnown, touchedBy, immediatelyBefore }
}

function mergeInto(target, source) {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value)
}

function table(map, total, always = []) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1])
  for (const name of always) if (!map.has(name)) rows.push([name, 0])
  return rows.map(([name, count]) => `${name} ${count} (${total ? ((count / total) * 100).toFixed(1) : '0.0'}%)`).join(' · ')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const parsed = parseSignature(args.signature)
  const files = await listSessionFiles()
  const cutoff = args.since ? Date.now() - args.since * 86_400_000 : null

  const shown = []
  const touchedBy = new Map()
  const immediatelyBefore = new Map()
  let occurrences = 0
  let targetsKnown = 0
  let scanned = 0
  let matchedSessions = 0

  for (const entry of files) {
    if (cutoff !== null && entry.mtimeMs < cutoff) continue
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
    scanned += 1
    const result = scanSession(session, parsed, args.context, args.limit - shown.length)
    if (result.occurrences > 0) matchedSessions += 1
    occurrences += result.occurrences
    targetsKnown += result.targetsKnown
    mergeInto(touchedBy, result.touchedBy)
    mergeInto(immediatelyBefore, result.immediatelyBefore)
    shown.push(...result.shown)
  }

  const report = {
    signature: args.signature,
    scanned,
    matchedSessions,
    occurrences,
    targetsKnown,
    touchedBy: Object.fromEntries([...touchedBy.entries()].sort((a, b) => b[1] - a[1])),
    immediatelyBefore: Object.fromEntries([...immediatelyBefore.entries()].sort((a, b) => b[1] - a[1])),
    samples: shown,
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`\n${args.signature} — ${occurrences} occurrence(s) in ${matchedSessions} of ${scanned} session(s)\n`)
  if (occurrences === 0) {
    console.log('  No occurrence in scope. Either the friction is gone or the signature key is wrong.\n')
    return
  }
  for (const [index, sample] of shown.entries()) {
    console.log(`[${index + 1}] ${shortId(sample.sessionId)}  ${sample.project}${sample.step === null ? '' : `  step ${sample.step}`}`)
    if (!sample.before.length) console.log('    before  (no earlier call)')
    for (const call of sample.before) console.log(`    before  ${call.name.padEnd(8)} ${call.args}`)
    if (sample.call) console.log(`    call    ${sample.call.name.padEnd(8)} ${sample.call.args}`)
    if (sample.error) console.log(`    error   ${sample.error}  ${sample.snippet ?? ''}`)
    console.log('')
  }
  if (occurrences > shown.length) console.log(`… ${occurrences - shown.length} more (raise --limit to see them)\n`)

  console.log(`aggregate over ${occurrences} occurrence(s)`)
  console.log(`  target known          ${targetsKnown}`)
  console.log(`  touched since last write ${table(touchedBy, targetsKnown, ['read'])}`)
  console.log(`  immediately before    ${table(immediatelyBefore, occurrences)}`)
  console.log('')
}

main().catch((error) => {
  console.error(`evidence failed: ${error.message}`)
  process.exit(1)
})
