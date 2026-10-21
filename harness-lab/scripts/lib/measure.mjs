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
 * `sessions` is the number of digests where the signature occurs at least once,
 * `hits` is every occurrence across them, and `sessionsPerHit` is their ratio
 * (higher means the friction is spread wide rather than concentrated). A
 * signature with no hits still returns a measured zero, which is different from
 * "not measured": the caller decides that distinction, not this module.
 *
 * @param {object[]} digests per-session digests as written by digest.mjs
 * @param {string} signature friction key, e.g. `edit:FsError/FS_NOT_OBSERVED`
 * @returns {{ sessions: number, hits: number, sessionsPerHit: number|null }}
 */
export function measureSignature(digests, signature) {
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
  return { sessions, hits, sessionsPerHit: hits === 0 ? null : sessions / hits }
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
