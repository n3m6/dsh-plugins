/**
 * Friction signatures: the unit a proposal is about.
 *
 * A signature is `tool:ErrorClass` for a failure, `repeat:tool` for a loop, or
 * `compaction` for context pressure. The signature — not the session — is what
 * accumulates evidence across projects, and what a rejection is keyed to.
 */

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
    for (const moment of digest.moments ?? []) {
      const key = signatureOf(moment)
      const entry = map.get(key) ?? {
        key,
        kind: moment.kind,
        tool: moment.tool,
        error: moment.error,
        sessions: new Set(),
        projects: new Set(),
        count: 0,
        lastSeen: null,
        samples: [],
      }
      entry.sessions.add(digest.sessionId)
      entry.projects.add(project)
      entry.count += 1
      const at = moment.at ?? digest.startedAt
      if (at && (!entry.lastSeen || at > entry.lastSeen)) entry.lastSeen = at
      if (moment.snippet && entry.samples.length < 2 && !entry.samples.includes(moment.snippet)) {
        entry.samples.push(moment.snippet)
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
