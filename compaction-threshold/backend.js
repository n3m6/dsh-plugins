/**
 * Preset-mounted compaction backend.
 *
 * Extends the shipped engine so every summarization, pruning, replay and
 * locking guarantee stays in one place. Only the pressure trigger is
 * reinterpreted: instead of a fixed window fraction it uses the live
 * `compactionThreshold` preference, converting it to the fraction the engine's
 * policy resolution expects for the currently routed model.
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Mirror of the settings plugin's default for the service-absent case. */
const DEFAULT_THRESHOLD_TOKENS = 300_000

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

const { BasicCompactionEngine } = await import(
  pathToFileURL(resolveShipped('@deepseek-ai/dsh-compaction-basic')).href
)

export default class CompactionThresholdEngine extends BasicCompactionEngine {
  /**
   * @param ctx - preset plugin context.
   * @param config - the shipped backend's Config, validated by its schema.
   */
  constructor(ctx, config) {
    super(ctx, config)
    /** Immutable engine policy, kept so every reinterpretation starts clean. */
    this.baseConfig = this.config
  }

  /** Read the live preference, falling back to the default when unserved. */
  thresholdTokens() {
    const policy = this.ctx.get('compactionThreshold')
    const value = policy?.thresholdTokens
    return Number.isFinite(value) ? value : DEFAULT_THRESHOLD_TOKENS
  }

  /**
   * Compact for pressure or overflow, using the configured absolute threshold
   * for pressure. The base method snapshots `this.config` synchronously before
   * its first await, so replacing the clone immediately before calling it is
   * safe for concurrent sessions.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal.
   * @returns the compaction result, or null when nothing ran.
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (trigger === 'pressure') {
      try {
        const header = agent.session.requestHeader()?.config
        if (header?.provider && header?.model) {
          const info = await this.ctx.llm.resolveModelInfo(header.provider, header.model, signal)
          const contextWindow = info.context?.contextWindow
          const threshold = this.thresholdTokens()
          if (Number.isInteger(contextWindow) && contextWindow > 0 && Number.isFinite(threshold) && threshold > 0) {
            const reserved = header.maxTokens ?? info.defaultMaxTokens ?? 0
            const messageBudget = Math.max(0, contextWindow - reserved)
            const configuredRetain = this.baseConfig.retainTokens
              ?? Math.floor(messageBudget * (this.baseConfig.retainRatio ?? 0.16))
            const retainTokens = Math.max(0, Math.min(configuredRetain, Math.floor(threshold / 2)))
            this.config = {
              ...this.baseConfig,
              thresholdRatio: Math.min(0.999, threshold / contextWindow),
              retainTokens,
            }
          }
        }
      } catch {
        // Fall through to the engine's own policy; its capacity error is clearer.
      }
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }
}
