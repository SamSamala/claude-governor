import { familyOf } from './price.mjs';

/**
 * Compaction window policy.
 *
 * Verified constraints from the Claude Code binary (v2.1.220):
 *   autoCompactWindow: E.number().int().min(1e5).max(1e6).optional().catch(void 0)
 *   -> resolved as Math.min(model_limit, configured)
 *   -> effective window = window - min(max_output_tokens, 20_000)
 *   -> precedence: CLAUDE_CODE_AUTO_COMPACT_WINDOW (env) > settings > model-default > auto
 *   -> `.catch(void 0)` means an OUT-OF-RANGE VALUE IS SILENTLY DISCARDED and falls back to auto.
 *
 * That last point is the dangerous one: a too-small value looks applied but does nothing.
 * Everything here exists to make that impossible to do by accident.
 */

export const WINDOW_MIN = 100_000;   // Tfo
export const WINDOW_MAX = 1_000_000; // Nds
export const OUTPUT_RESERVE = 20_000; // mMu

/** User-directed policy: compact at 50% of window for Sonnet, 25% for Opus. */
export const DEFAULT_PCT = {
  sonnet: 0.50,
  opus: 0.25,
  haiku: 0.50,
};

/**
 * Known default context windows, from the binary's model table.
 * These are a FALLBACK ONLY — the live value observed from the statusline payload
 * (`context_window.context_window_size`) is authoritative and should be preferred.
 */
export const KNOWN_WINDOWS = {
  // Read from the binary's model registry (`context: { window: … }`).
  'claude-sonnet-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  // Older Opus builds are 200k — where a 25% policy lands below the floor and must clamp.
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
};

const DEFAULT_WINDOW = 200_000;

/**
 * settings.json commonly holds an ALIAS ("opus", "sonnet", "opusplan") rather than a
 * full model id. Resolving those to the current model matters: treating "opus" as an
 * unknown 200k model produces a 100k window that compacts every ~42k tokens and thrashes.
 */
export const ALIASES = {
  opus: 'claude-opus-5',
  opusplan: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  default: 'claude-sonnet-5',
};

export function canonicalModel(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  return ALIASES[id] || modelId;
}

/** Resolve a model's context window; an observed value always beats the table. */
export function resolveWindow(modelId, observed) {
  if (typeof observed === 'number' && observed >= WINDOW_MIN) return observed;
  const id = String(canonicalModel(modelId) || '');
  if (KNOWN_WINDOWS[id]) return KNOWN_WINDOWS[id];
  for (const [k, v] of Object.entries(KNOWN_WINDOWS)) {
    if (id.startsWith(k)) return v;
  }
  return DEFAULT_WINDOW;
}

/**
 * Compute the autoCompactWindow value to write.
 *
 * Returns a decision object that ALWAYS explains itself, so the installer can warn
 * instead of silently doing something other than what the user asked for.
 */
export function computeWindow(modelId, { observedWindow, pct = DEFAULT_PCT } = {}) {
  const family = familyOf(modelId);
  const fraction = pct[family] ?? 0.5;
  const modelWindow = resolveWindow(modelId, observedWindow);
  const target = Math.round(modelWindow * fraction);

  let value = target;
  const warnings = [];

  if (target < WINDOW_MIN) {
    value = WINDOW_MIN;
    warnings.push(
      `${family} policy asks for ${fraction * 100}% of ${modelWindow.toLocaleString('en-US')} = ` +
      `${target.toLocaleString('en-US')} tokens, which is below the hard floor of ${WINDOW_MIN.toLocaleString('en-US')}. ` +
      `Clamped to ${WINDOW_MIN.toLocaleString('en-US')}. ` +
      `Without this clamp the value would be SILENTLY DISCARDED and compaction would revert to auto.`
    );
  }
  if (target > WINDOW_MAX) {
    value = WINDOW_MAX;
    warnings.push(
      `Target ${target.toLocaleString('en-US')} exceeds the maximum ${WINDOW_MAX.toLocaleString('en-US')}; clamped.`
    );
  }
  if (value > modelWindow) {
    value = Math.max(WINDOW_MIN, Math.min(modelWindow, WINDOW_MAX));
    warnings.push(
      `Target exceeded the model's own limit (${modelWindow.toLocaleString('en-US')}); clamped to ${value.toLocaleString('en-US')}.`
    );
  }

  return {
    model: modelId,
    family,
    fraction,
    modelWindow,
    target,
    value,
    clamped: value !== target,
    // What the model will actually experience, after the output reserve.
    effectiveWindow: value - Math.min(OUTPUT_RESERVE, value),
    warnings,
    windowSource: (typeof observedWindow === 'number' && observedWindow >= WINDOW_MIN)
      ? 'observed'
      : (KNOWN_WINDOWS[String(canonicalModel(modelId) || '')] ? 'table' : 'default'),
  };
}

/** True when the value would survive the binary's zod schema. */
export function isAcceptable(value) {
  return Number.isInteger(value) && value >= WINDOW_MIN && value <= WINDOW_MAX;
}

/**
 * Detect the env override that silently outranks settings.
 * (precedence: CLAUDE_CODE_AUTO_COMPACT_WINDOW > settings > model-default > auto)
 */
export function envOverride(env = process.env) {
  const raw = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (!raw) return null;
  const n = Number(String(raw).trim());
  return {
    raw,
    parsed: Number.isFinite(n) ? n : null,
    message:
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${raw} is set and takes precedence over settings.json. ` +
      `Governor's window policy will NOT take effect until it is unset.`,
  };
}
