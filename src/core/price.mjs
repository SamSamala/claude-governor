/**
 * Pricing table — USD per million tokens.
 *
 * Plan failure mode #12: pricing changes. This is the ONE place to edit.
 * Everything downstream reports tokens as primary and $ as a clearly-labelled estimate.
 *
 * Cache multipliers follow Anthropic's published model:
 *   cache read      = 0.1x base input
 *   cache write 5m  = 1.25x base input
 *   cache write 1h  = 2.0x base input
 */

export const PRICING = {
  opus:   { input: 15.0, output: 75.0 },
  sonnet: { input: 3.0,  output: 15.0 },
  haiku:  { input: 1.0,  output: 5.0 },
};

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2.0;

/** Map an arbitrary model id to a pricing family. Unknown => sonnet (middle estimate). */
export function familyOf(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet';
}

export function rates(modelId) {
  const fam = PRICING[familyOf(modelId)];
  return {
    family: familyOf(modelId),
    input: fam.input,
    output: fam.output,
    cacheRead: fam.input * CACHE_READ_MULT,
    cacheWrite5m: fam.input * CACHE_WRITE_5M_MULT,
    cacheWrite1h: fam.input * CACHE_WRITE_1H_MULT,
  };
}

/** Cost in USD for one normalized usage record. Estimate only. */
export function costOf(usage, modelId) {
  const r = rates(modelId);
  const per = (tok, rate) => (tok / 1e6) * rate;
  return (
    per(usage.input, r.input) +
    per(usage.output, r.output) +
    per(usage.cacheRead, r.cacheRead) +
    per(usage.write1h, r.cacheWrite1h) +
    per(usage.write5m + usage.unsplitWrite, r.cacheWrite5m)
  );
}

/**
 * Retention cost — the plan's core insight.
 * A tool result costs `size x turns_remaining`, not `size`: once admitted it is
 * re-read on every subsequent request at the cache-read rate.
 */
export function retentionCost(sizeTokens, turnsRemaining, modelId) {
  const r = rates(modelId);
  return (sizeTokens * Math.max(0, turnsRemaining) / 1e6) * r.cacheRead;
}

export function fmtUSD(n) {
  return `$${n.toFixed(2)}`;
}

/** Always en-US grouping: system locales (e.g. en-IN) render 967000 as "9,67,000". */
export function fmtTok(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}
