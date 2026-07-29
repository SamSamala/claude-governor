/**
 * Compaction counterfactual.
 *
 * Calibrated against real observed behaviour rather than assumption. In this corpus a
 * session compacted at 408,536 tokens against Sonnet 5's 967,000 window and dropped to
 * 82,126 — so:
 *    trigger  ~= 0.42 x configured window
 *    reset-to ~= 0.20 x trigger
 *
 * Both are exposed so the numbers can be re-derived per user instead of hardcoded.
 */

export const OBSERVED_TRIGGER_FRACTION = 0.42;
export const OBSERVED_RESET_FRACTION = 0.20;

/** Reconstruct per-request admissions from an observed context trail. */
export function deltasOf(trail) {
  const d = [];
  for (let i = 0; i < trail.length; i++) {
    d.push(i === 0 ? trail[0] : Math.max(0, trail[i] - trail[i - 1]));
  }
  return d;
}

/**
 * Replay a session's admissions under a configured window and report total input tokens.
 * Also counts compactions so thrash is visible rather than hidden in an average.
 */
export function simulateSession(trail, windowValue, opts = {}) {
  const triggerFrac = opts.triggerFraction ?? OBSERVED_TRIGGER_FRACTION;
  const resetFrac = opts.resetFraction ?? OBSERVED_RESET_FRACTION;
  const trigger = windowValue * triggerFrac;
  const resetTo = trigger * resetFrac;

  const deltas = deltasOf(trail);
  let ctx = Math.min(trail[0] ?? 0, trigger);
  let total = 0;
  let compactions = 0;

  for (const d of deltas) {
    ctx += d;
    if (ctx > trigger) {
      ctx = resetTo;
      compactions++;
    }
    total += ctx;
  }
  return { total, compactions, trigger, resetTo };
}

export function simulateAll(sessions, windowValue, opts = {}) {
  let total = 0, compactions = 0, thrashy = 0;
  for (const s of sessions) {
    if (!s.ctxTrail?.length) continue;
    const r = simulateSession(s.ctxTrail, windowValue, opts);
    total += r.total;
    compactions += r.compactions;
    // More than one compaction per 25 turns is thrash territory.
    if (r.compactions > s.ctxTrail.length / 25) thrashy++;
  }
  return { total, compactions, thrashySessions: thrashy };
}

export function actualTotal(sessions) {
  let t = 0;
  for (const s of sessions) for (const v of s.ctxTrail || []) t += v;
  return t;
}
