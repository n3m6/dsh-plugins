/**
 * Global compaction-threshold preference.
 *
 * Owns one volatile Config field and exposes it to the per-session compaction
 * backend through `ctx.compactionThreshold`. The field is volatile so the
 * Settings form can rewrite it without remounting this plugin; the reference
 * the Loader commits the new value into is read on every access.
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Default trigger, chosen to sit near 300k on the shipped 1M-token route. */
const DEFAULT_THRESHOLD_TOKENS = 300_000
/** Lower bound accepts useful small-context models without inviting thrash. */
const MIN_THRESHOLD_TOKENS = 16_000
/** Upper bound stays below the largest context windows the adapters declare. */
const MAX_THRESHOLD_TOKENS = 2_000_000

/**
 * Derive the running dsh installation root.
 *
 * The Host process carries no DSH_* environment, so walk from the executable
 * entry that launched it (`<dsh-root>/lib/bin.js`).
 * @returns the installation root, or undefined when the entry is unknown.
 */
function dshInstallationRoot() {
  try {
    return process.argv[1] === undefined ? undefined : dirname(dirname(realpathSync(process.argv[1])))
  } catch {
    return undefined
  }
}

/**
 * Resolve a package shipped with the Harness from the running profile.
 *
 * A locally installed bundle is linked by pnpm, so Node resolves its bare
 * imports from the checkout rather than the profile. Resolving through the
 * profile keeps every shipped package available without declaring (and
 * duplicating) dependencies.
 * @param specifier - package specifier shipped with DSH.
 * @returns absolute path to the package entry.
 */
function resolveShipped(specifier) {
  const bases = [
    process.env.DSH_PROFILE_DIR,
    process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'profiles'),
    dshInstallationRoot(),
    process.cwd(),
  ].filter((base) => base !== undefined)
  for (const base of bases) {
    try {
      return createRequire(join(base, 'package.json')).resolve(specifier)
    } catch {
      // Try the next resolution base.
    }
  }
  throw new Error(`compaction-threshold: cannot resolve ${specifier} from the DSH profile`)
}

const { default: z } = await import(pathToFileURL(resolveShipped('@deepseek-ai/schemastery')).href)

/** One live preference: the token length that triggers compaction. */
const Config = z.object({
  thresholdTokens: z.number()
    .min(MIN_THRESHOLD_TOKENS)
    .max(MAX_THRESHOLD_TOKENS)
    .default(DEFAULT_THRESHOLD_TOKENS)
    .volatile(),
})

/**
 * Provide the live threshold to any compaction backend in this profile.
 * @param ctx - Host plugin context.
 * @param config - validated Config whose volatile field is a live reference.
 */
function apply(ctx, config) {
  const reference = config.thresholdTokens
  const read = () => {
    if (typeof reference === 'number') return reference
    const value = reference?.get?.()
    return Number.isFinite(value) ? value : DEFAULT_THRESHOLD_TOKENS
  }
  ctx.provide('compactionThreshold', {
    /** Current trigger in tokens, as last committed by the Settings form. */
    get thresholdTokens() {
      return read()
    },
    min: MIN_THRESHOLD_TOKENS,
    max: MAX_THRESHOLD_TOKENS,
    default: DEFAULT_THRESHOLD_TOKENS,
  })
}

export { Config, apply }
