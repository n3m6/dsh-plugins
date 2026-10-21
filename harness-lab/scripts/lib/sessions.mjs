/**
 * Session-log discovery, parsing, and the per-session metric vector.
 *
 * A session log is a zstd-compressed JSONL stream of `{ type, seq, time, data }`
 * records whose first record is the session header (id, cwd, agentPreset).
 * Everything here is derived from those records alone: no DSH runtime needed.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decompressSessionLog } from './zstd.mjs'
import { signatureOf } from './signatures.mjs'

export const SESSIONS_ROOT = process.env.DSH_SESSIONS_DIR ?? join(homedir(), '.dsh', 'sessions')

const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** Every session directory's session.jsonl[.zstd] under the sessions root. */
export async function listSessionFiles(root = SESSIONS_ROOT) {
  const files = []
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    const sessions = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const file = join(projectDir, session.name, name)
        const info = await stat(file).catch(() => null)
        if (info?.isFile()) {
          files.push({ file, corpus: project.name, sessionDir: session.name, mtimeMs: info.mtimeMs })
          break
        }
      }
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

export async function readSession(file) {
  const raw = await readFile(file)
  const text = file.endsWith('.zstd') ? decompressSessionLog(raw).text : raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // A truncated tail is normal for a live session; skip the partial record.
    }
  }
  const header = events.find((event) => event.type === 'session') ?? {}
  return {
    id: header.id ?? null,
    cwd: header.cwd ?? null,
    agentPreset: header.agentPreset ?? null,
    createdAt: header.createdAt ?? null,
    events,
  }
}

function parseArguments(raw) {
  if (typeof raw !== 'string') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function resultText(event) {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type !== 'tool-result') continue
    for (const inner of block.content ?? []) {
      if (inner?.type === 'text') parts.push(inner.text)
    }
  }
  return parts.join('\n')
}

function signal(event) {
  return { turn: event.data?.turn ?? null, step: event.data?.step ?? null }
}

/**
 * Compute the metric vector and the three highest-value friction moments.
 * The vector is deliberately a set of independent counters: the spec forbids a
 * composite score, so every proposal has to name the dimension it moves.
 */
export function computeMetrics(session, { maxMoments = 3 } = {}) {
  const { events } = session
  const metrics = {
    steps: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    repeatRate: 0,
    retryRate: 0,
    compactions: 0,
    clarifications: 0,
    approvals: 0,
    presented: false,
    writeFailures: 0,
    skillInvocations: {},
    /** Every signature occurrence in this session, not just the displayed moments. */
    signatures: {},
    toolsByName: {},
    errorsByClass: {},
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    wallMs: 0,
    outcome: null,
  }

  const moments = []
  const signatureCounts = new Map()
  /**
   * Record one friction occurrence.
   *
   * The moment list is capped for display, but the histogram is not: clustering
   * and every before/after rate read `metrics.signatures`, so capping it would
   * silently make each count a lower bound and rank a shallow-wide signature
   * above a deep-narrow one.
   */
  const record = (moment) => {
    const key = signatureOf(moment)
    signatureCounts.set(key, (signatureCounts.get(key) ?? 0) + 1)
    moments.push(moment)
  }
  const callById = new Map()
  let previousKey = null
  let repeats = 0
  let retries = 0
  let lastError = null // { name, step }
  const openTurns = new Map()

  for (const event of events) {
    const { turn, step } = signal(event)

    if (event.type === 'turn/start') {
      openTurns.set(event.data?.turn ?? 0, event.time ?? Date.now())
      metrics.turns += 1
      continue
    }
    if (event.type === 'turn/end') {
      const key = event.data?.turn ?? 0
      const startedAt = openTurns.get(key)
      if (startedAt && event.time) metrics.wallMs += event.time - startedAt
      metrics.outcome = event.data?.reason?.kind ?? metrics.outcome
      continue
    }
    if (event.type === 'step/start') {
      metrics.steps += 1
      continue
    }
    if (event.type === 'compaction/start') {
      // One occurrence per compaction, not one per boundary event.
      metrics.compactions += 1
      record({ kind: 'compaction', step, tool: null, error: null, snippet: '', at: event.time ?? null })
      continue
    }
    if (event.type === 'compaction/end') continue
    if (event.type.startsWith('approval/') && event.type !== 'approval/policy') {
      metrics.approvals += 1
      continue
    }
    if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage) {
        metrics.tokens.input += usage.inputTokens ?? 0
        metrics.tokens.output += usage.outputTokens ?? 0
        metrics.tokens.reasoning += usage.reasoningTokens ?? 0
        metrics.tokens.cacheRead += usage.cacheReadTokens ?? 0
      }
      continue
    }
    if (event.type === 'agent/error') {
      metrics.outcome = 'error'
      continue
    }
    if (event.type === 'tool/call') {
      const name = event.data?.name ?? 'unknown'
      const args = parseArguments(event.data?.arguments)
      const key = `${name}|${event.data?.arguments ?? ''}`.slice(0, 400)
      metrics.toolCalls += 1
      metrics.toolsByName[name] = (metrics.toolsByName[name] ?? 0) + 1
      callById.set(event.data?.callId, { name, args, step })
      if (previousKey === key) {
        repeats += 1
        record({
          kind: 'repeat',
          step,
          tool: name,
          error: null,
          snippet: JSON.stringify(args).slice(0, 160),
          at: event.time ?? null,
        })
      }
      if (lastError && lastError.name === name && step != null && step - lastError.step <= 1) retries += 1
      previousKey = key
      if (name === 'ask_user_question') metrics.clarifications += 1
      if (name === 'present') metrics.presented = true
      if (name === 'skill') {
        const skill = args.skill ?? args.name ?? args.skillName ?? '(unnamed)'
        metrics.skillInvocations[skill] = (metrics.skillInvocations[skill] ?? 0) + 1
      }
      continue
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId
      const call = callId ? callById.get(callId) : null
      const name = call?.name ?? 'unknown'
      const error = event.data?.error
      if (error) {
        const errorClass = `${error.name ?? 'Error'}/${error.code ?? 'UNKNOWN'}`
        metrics.toolErrors += 1
        metrics.errorsByClass[errorClass] = (metrics.errorsByClass[errorClass] ?? 0) + 1
        if (WRITE_TOOLS.has(name)) metrics.writeFailures += 1
        lastError = { name, step: call?.step ?? step }
        record({
          kind: 'error',
          step: call?.step ?? step,
          tool: name,
          error: errorClass,
          snippet: resultText(event).replace(/\s+/g, ' ').slice(0, 160),
          at: event.time ?? null,
        })
      }
    }
  }

  metrics.signatures = Object.fromEntries([...signatureCounts].sort(([a], [b]) => a.localeCompare(b)))
  metrics.repeatRate = metrics.toolCalls ? repeats / metrics.toolCalls : 0
  metrics.retryRate = metrics.toolCalls ? retries / metrics.toolCalls : 0

  const priority = { error: 0, repeat: 1, compaction: 2 }
  const topMoments = moments
    .sort((a, b) => priority[a.kind] - priority[b.kind] || (a.step ?? 0) - (b.step ?? 0))
    .slice(0, maxMoments)

  return { metrics, moments: topMoments }
}

/** One digest per session: identity, vector, moments. */
export function buildDigest(session, file) {
  const { metrics, moments } = computeMetrics(session)
  return {
    sessionId: session.id,
    file,
    cwd: session.cwd,
    project: session.cwd ? session.cwd.split('/').filter(Boolean).slice(-1)[0] : null,
    projectRoot: session.cwd,
    agentPreset: session.agentPreset,
    startedAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
    metrics,
    moments,
  }
}
