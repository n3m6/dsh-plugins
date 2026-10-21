/**
 * Signature measurement over per-session digests.
 *
 * An edit set names the one friction signature it targets, and the applier
 * records that signature's rate over the existing digests as the adoption's
 * baseline. P1 re-measures the same signature over sessions after the adoption
 * and compares the two, so this module is the single definition of "the rate".
 *
 * Everything except `loadDigests` is pure: no clock, no filesystem, no options
 * that could make the baseline and the later comparison disagree.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { signatureOf } from './signatures.mjs'

/**
 * Count one signature across digests.
 *
 * Two ratios matter and they answer different questions. `hitsPerSession` is
 * occurrences per *session in the corpus*, so it falls when sessions stop
 * hitting the friction and also when they stop happening at all — it is the
 * rate a proposal is judged by. `sessionsPerHit` is how concentrated the hits
 * are (lower means fewer sessions carry more of them) and is reported for
 * reading, never for a verdict, because it moves when a fix merely spreads the
 * same failures over more sessions.
 *
 * A signature with no hits still returns a measured zero over a non-empty
 * corpus, which is different from "not measured": the caller decides that
 * distinction, not this module.
 *
 * @param {object[]} digests per-session digests as written by digest.mjs
 * @param {string} signature friction key, e.g. `edit:FsError/FS_NOT_OBSERVED`
 * @returns {{ corpusSessions: number, sessions: number, hits: number,
 *             hitsPerSession: number|null, sessionsPerHit: number|null }}
 */
export function measureSignature(digests, signature) {
  const corpusSessions = digests.length
  let sessions = 0
  let hits = 0
  for (const digest of digests) {
    let seen = 0
    for (const moment of digest.moments ?? []) {
      if (signatureOf(moment) === signature) seen += 1
    }
    if (seen > 0) {
      sessions += 1
      hits += seen
    }
  }
  return {
    corpusSessions,
    sessions,
    hits,
    hitsPerSession: corpusSessions === 0 ? null : hits / corpusSessions,
    sessionsPerHit: hits === 0 ? null : sessions / hits,
  }
}

/** A rise past this share of the baseline counts as a regression worth reverting. */
export const REGRESSION_BAND = 0.25

/**
 * Judge one adoption by its before/after rates.
 *
 * `kept` means the rate fell at all; `reverted` means it rose by more than
 * `REGRESSION_BAND`; anything in between is `inconclusive` rather than a
 * verdict, because a flat rate cannot distinguish a weak fix from an unchanged
 * one. A missing or zero baseline is inconclusive by construction: there is no
 * rate to compare against, and claiming a win from it would be an artifact.
 *
 * @param {{hitsPerSession: number|null}|null} baseline rate recorded at apply time
 * @param {{hitsPerSession: number|null, corpusSessions: number}|null} after rate over later sessions
 * @returns {{ state: 'kept'|'reverted'|'inconclusive', reason: string|null }}
 */
export function classifyOutcome(baseline, after) {
  if (!baseline || baseline.hitsPerSession === null || baseline.hitsPerSession === undefined) {
    return { state: 'inconclusive', reason: 'no baseline rate' }
  }
  if (!after || after.corpusSessions === 0) {
    return { state: 'inconclusive', reason: 'no later sessions' }
  }
  const before = baseline.hitsPerSession
  const now = after.hitsPerSession ?? 0
  if (before === 0) {
    return now > 0
      ? { state: 'reverted', reason: `rose from a zero baseline to ${now.toFixed(2)} per session` }
      : { state: 'inconclusive', reason: 'baseline rate was already zero' }
  }
  if (now < before) return { state: 'kept', reason: null }
  if (now > before * (1 + REGRESSION_BAND)) {
    return { state: 'reverted', reason: `rose ${(((now - before) / before) * 100).toFixed(0)}% past the ${REGRESSION_BAND * 100}% band` }
  }
  return { state: 'inconclusive', reason: 'rate is flat within the regression band' }
}

/**
 * Read every digest in `dir`, in filename order so repeated runs are stable.
 *
 * A missing directory is an empty corpus (the lab has not digested anything
 * yet). An unparsable file is an error: silently dropping a digest would shrink
 * a baseline without anyone noticing, which is the one failure this module
 * exists to prevent.
 *
 * @param {string} dir directory of `<session>.json` digests
 * @returns {Promise<object[]>}
 */
export async function loadDigests(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const digests = []
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (parsed && typeof parsed === 'object') digests.push(parsed)
    } catch (error) {
      throw new Error(`${file}: ${error.message}`)
    }
  }
  return digests
}
