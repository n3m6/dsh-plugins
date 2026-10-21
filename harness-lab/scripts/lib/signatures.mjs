/**
 * Friction signatures: the unit a proposal is about.
 *
 * A signature is `tool:ErrorClass` for a failure, `repeat:tool` for a loop, or
 * `compaction` for context pressure. The signature — not the session — is what
 * accumulates evidence across projects, and what a rejection is keyed to.
 */

/** Split a signature key back into its parts. */
export function parseSignature(key) {
  if (key === 'compaction') return { kind: 'compaction', tool: null, error: null }
  const at = key.indexOf(':')
  if (at === -1) return { kind: 'error', tool: key, error: null }
  const head = key.slice(0, at)
  const tail = key.slice(at + 1)
  if (head === 'repeat') return { kind: 'repeat', tool: tail, error: null }
  return { kind: 'error', tool: head, error: tail }
}

/**
 * Every occurrence of every signature in one digest.
 *
 * `metrics.signatures` is the whole-session histogram. Digests written before
 * that field existed carry only the three display moments, so they fall back to
 * those and stay readable at the cost of being a lower bound.
 */
export function signatureCounts(digest) {
  const histogram = digest.metrics?.signatures
  if (histogram && Object.keys(histogram).length > 0) return histogram
  const counts = {}
  for (const moment of digest.moments ?? []) {
    const key = signatureOf(moment)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export function signatureOf(moment) {
  if (moment.kind === 'error') return `${moment.tool}:${moment.error}`
  if (moment.kind === 'repeat') return `repeat:${moment.tool}`
  return 'compaction'
}

/**
 * Cluster moments across digests.
 * @param {object[]} digests per-session digests
 * @returns {object[]} signatures sorted by reach, then frequency
 */
export function collectSignatures(digests) {
  const map = new Map()
  for (const digest of digests) {
    const project = digest.project ?? '(unknown)'
    for (const [key, count] of Object.entries(signatureCounts(digest))) {
      const { kind, tool, error } = parseSignature(key)
      const entry = map.get(key) ?? {
        key,
        kind,
        tool,
        error,
        sessions: new Set(),
        projects: new Set(),
        count: 0,
        lastSeen: null,
        samples: [],
      }
      entry.sessions.add(digest.sessionId)
      entry.projects.add(project)
      entry.count += count
      const at = digest.startedAt
      if (at && (!entry.lastSeen || at > entry.lastSeen)) entry.lastSeen = at
      if (entry.samples.length < 2) {
        const moment = (digest.moments ?? []).find((item) => signatureOf(item) === key)
        if (moment?.snippet && !entry.samples.includes(moment.snippet)) entry.samples.push(moment.snippet)
      }
      map.set(key, entry)
    }
  }

  return [...map.values()]
    .map((entry) => ({
      ...entry,
      sessions: [...entry.sessions].filter(Boolean),
      projects: [...entry.projects],
    }))
    .sort(
      (a, b) =>
        b.projects.length - a.projects.length ||
        b.sessions.length - a.sessions.length ||
        b.count - a.count,
    )
}

/** Evidence bar from the spec: reach for global edits, recurrence for project edits. */
export function candidatesFor(signatures, { mode } = {}) {
  if (mode === 'project') return signatures.filter((entry) => entry.sessions.length >= 2)
  return signatures.filter((entry) => entry.projects.length >= 3)
}

/** Signatures a rejection still covers, keyed to their cooldown expiry. */
export function activeRejections(rejections, now = Date.now()) {
  const active = new Map()
  for (const [key, record] of Object.entries(rejections ?? {})) {
    const until = new Date(record.until ?? 0).getTime()
    if (Number.isFinite(until) && until > now) active.set(key, record)
  }
  return active
}

/**
 * Apply the evidence bar and the cooldown together.
 *
 * The digest and its tests both call this, so "a rejected signature stops being
 * a candidate" has exactly one implementation and cannot drift between them.
 *
 * @param {object[]} signatures clustered signatures
 * @param {{mode?: 'global'|'project', rejections?: object, now?: number, limit?: number}} options
 * @returns {{cooling: Map<string, object>, candidates: object[]}}
 */
export function selectCandidates(signatures, { mode, rejections = {}, now = Date.now(), limit = Infinity } = {}) {
  const cooling = activeRejections(rejections, now)
  const eligible = signatures.filter((entry) => !cooling.has(entry.key))
  return {
    cooling,
    candidates: candidatesFor(eligible, { mode }).slice(0, limit),
  }
}
