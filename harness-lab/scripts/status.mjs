#!/usr/bin/env node
/**
 * One screen on the lab's state: adoptions, rejections, and drift.
 *
 *   node scripts/status.mjs
 *   node scripts/status.mjs --json
 *
 * This is a report, not a gate: it always exits 0. Drift is the part worth
 * reading — an EXPERIENCE line with no adoption, an adoption with no line, a
 * file edited after the lab wrote it, or a signature nobody ever digested. Each
 * of those means the loop cannot be trusted to measure what it thinks it is
 * measuring, and each is invisible in the digest's own output.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { paths, readJson, readText, sha256 } from './lib/lab.mjs'
import { loadDigests, measureSignature } from './lib/measure.mjs'
import { activeRejections } from './lib/signatures.mjs'

const DAY_MS = 86_400_000

function rate(value) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(2)
}

/** Ids named by the first field of an EXPERIENCE.md entry line. */
function experienceIds(text) {
  const ids = []
  for (const line of (text ?? '').split('\n')) {
    const match = /^- \d{4}-\d{2}-\d{2} · `([^`]+)`/.exec(line)
    if (match) ids.push(match[1])
  }
  return ids
}

async function listAdoptions() {
  const entries = await readdir(paths.adoptions).catch(() => [])
  const adoptions = []
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue
    const record = await readJson(join(paths.adoptions, name), null)
    if (record) adoptions.push(record)
  }
  return adoptions
}

/** Compare each adopted file with the hash recorded when the lab last wrote it. */
async function fileDrift(record) {
  const drift = []
  for (const entry of record.files ?? []) {
    if (entry.deleted) continue
    const text = await readText(entry.file)
    if (text === null) {
      drift.push({ kind: 'file-missing', adoption: record.id, file: entry.file })
      continue
    }
    const actual = sha256(text)
    if (entry.afterHash && actual !== entry.afterHash) {
      drift.push({ kind: 'file-changed', adoption: record.id, file: entry.file, expected: entry.afterHash, actual })
    }
  }
  return drift
}

async function main() {
  const json = process.argv.includes('--json')
  const now = Date.now()
  const digests = await loadDigests(paths.digests)
  const adoptions = await listAdoptions()
  const rejections = await readJson(paths.rejections, {})
  const experienceText = await readText(paths.experience)
  const recorded = experienceIds(experienceText)

  const rows = []
  const drift = []

  for (const record of adoptions) {
    const later = digests.filter((digest) => {
      const started = digest.startedAt ? Date.parse(digest.startedAt) : Number.NaN
      return Number.isFinite(started) && started > Date.parse(record.at)
    })
    const measured = record.signature ? measureSignature(later, record.signature) : null
    const state = record.revertedAt ? 'reverted-manually' : record.resolution?.state ?? 'pending'
    rows.push({
      id: record.id,
      at: record.at,
      signature: record.signature ?? null,
      state,
      baseline: record.baseline?.hitsPerSession ?? null,
      current: measured?.hitsPerSession ?? null,
      laterSessions: measured?.corpusSessions ?? 0,
    })

    if (record.signature && digests.length === 0) {
      drift.push({ kind: 'no-digests', adoption: record.id, signature: record.signature })
    }
    if (!recorded.includes(record.id)) drift.push({ kind: 'not-in-experience', adoption: record.id })
    drift.push(...(await fileDrift(record)))
  }

  for (const id of recorded) {
    if (!adoptions.some((record) => record.id === id)) drift.push({ kind: 'orphan-experience-line', id })
  }

  const cooling = activeRejections(rejections, now)
  const rejectionsView = [...cooling.entries()].map(([signature, record]) => ({
    signature,
    reason: record.reason ?? null,
    daysLeft: Math.max(0, Math.ceil((Date.parse(record.until) - now) / DAY_MS)),
    until: record.until,
  }))

  if (json) {
    console.log(JSON.stringify({ at: new Date(now).toISOString(), corpusSessions: digests.length, adoptions: rows, rejections: rejectionsView, drift }, null, 2))
    return
  }

  console.log(`\nHarness Lab — status  (corpus ${digests.length} session(s))`)
  console.log('\n  adoptions')
  if (rows.length === 0) console.log('    none')
  for (const row of rows) {
    console.log(`    ${row.id.padEnd(20)} ${row.state.padEnd(18)} ${String(row.signature ?? '—').padEnd(34)} ${rate(row.baseline)} → ${rate(row.current)}  (${row.laterSessions} later)`)
  }

  console.log('\n  rejections')
  if (rejectionsView.length === 0) console.log('    none active')
  for (const row of rejectionsView) {
    console.log(`    ${row.signature.padEnd(40)} ${String(row.daysLeft).padStart(3)} day(s) left${row.reason ? `  — ${row.reason}` : ''}`)
  }

  console.log('\n  drift')
  if (drift.length === 0) console.log('    none')
  for (const item of drift) {
    if (item.kind === 'orphan-experience-line') {
      console.log(`    ${item.kind.padEnd(24)} \`${item.id}\` has an EXPERIENCE line but no adoption record`)
    } else if (item.kind === 'not-in-experience') {
      console.log(`    ${item.kind.padEnd(24)} ${item.adoption} has no EXPERIENCE line`)
    } else if (item.kind === 'no-digests') {
      console.log(`    ${item.kind.padEnd(24)} ${item.adoption} targets ${item.signature} but no digests exist`)
    } else if (item.kind === 'file-changed') {
      console.log(`    ${item.kind.padEnd(24)} ${item.file} differs from the hash written by ${item.adoption}`)
    } else if (item.kind === 'file-missing') {
      console.log(`    ${item.kind.padEnd(24)} ${item.file} was recorded by ${item.adoption} but is gone`)
    }
  }
  console.log('')
}

main().catch((error) => {
  console.error(`status failed: ${error.message}`)
  process.exit(1)
})
