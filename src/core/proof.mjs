import { readJSON, writeJSON } from './state.mjs';

/**
 * Falsifiability.
 *
 * The main criticism of every tool in this space is that it claims "95% savings" with no
 * counterfactual. Governor has to hold itself to the same standard, so it measures
 * before/after against the user's OWN sessions and reports the result whatever it says.
 *
 * Crucially it tracks TURNS as well as tokens: a token win that costs extra
 * back-and-forth is a regression, not a saving, and must be reported as one.
 */

export const BASELINE = 'baseline.json';

/** Metrics that describe how expensive a session is, independent of how many sessions there are. */
export function metricsFor(sessions) {
  const usable = sessions.filter((s) => s.requests > 0);
  const n = usable.length;
  if (!n) return null;

  const totalInput = usable.reduce((a, s) => a + s.totalInput, 0);
  const totalReqs = usable.reduce((a, s) => a + s.requests, 0);
  const totalOut = usable.reduce((a, s) => a + s.output, 0);
  const compactions = usable.reduce((a, s) => a + s.compactions, 0);

  // Per-session peak context: the thing the window policy is supposed to bound.
  const peaks = usable.map((s) => Math.max(0, ...(s.ctxTrail || [0])));
  peaks.sort((a, b) => a - b);

  return {
    sessions: n,
    requests: totalReqs,
    tokensPerRequest: totalInput / totalReqs,
    requestsPerSession: totalReqs / n,      // proxy for turns-to-completion
    outputPerRequest: totalOut / totalReqs,
    medianPeakContext: peaks[Math.floor(peaks.length / 2)] || 0,
    compactionsPerSession: compactions / n,
    totalInput,
  };
}

export function saveBaseline(sessions, extra = {}) {
  const m = metricsFor(sessions);
  if (!m) return null;
  const snap = { takenAt: Date.now(), metrics: m, ...extra };
  writeJSON(BASELINE, snap);
  return snap;
}

export function loadBaseline() {
  return readJSON(BASELINE, null);
}

/**
 * Compare sessions recorded AFTER the baseline against the baseline itself.
 * Returns null when there is not yet enough post-baseline data to say anything —
 * saying nothing is better than reporting noise as a win.
 */
export function compare(sessions, baseline, { minSessions = 3 } = {}) {
  if (!baseline?.metrics) return { error: 'no baseline — run `governor baseline` first' };

  const after = sessions.filter((s) => s.mtime > baseline.takenAt && s.requests > 0);
  if (after.length < minSessions) {
    return {
      error: `only ${after.length} session(s) since the baseline; need ${minSessions} before a comparison means anything`,
      after: after.length,
    };
  }

  const now = metricsFor(after);
  const was = baseline.metrics;
  const delta = (k) => (was[k] ? (now[k] - was[k]) / was[k] : 0);

  const tokensPerRequest = delta('tokensPerRequest');
  const requestsPerSession = delta('requestsPerSession');

  // A token win that costs turns is not a win.
  let verdict;
  if (tokensPerRequest < -0.05 && requestsPerSession > 0.20) {
    verdict = 'REGRESSION — fewer tokens per request, but noticeably more turns to finish';
  } else if (tokensPerRequest < -0.05) {
    verdict = 'IMPROVED';
  } else if (tokensPerRequest > 0.05) {
    verdict = 'WORSE';
  } else {
    verdict = 'NO CHANGE';
  }

  return {
    verdict,
    was, now,
    deltas: {
      tokensPerRequest,
      requestsPerSession,
      medianPeakContext: delta('medianPeakContext'),
      outputPerRequest: delta('outputPerRequest'),
      compactionsPerSession: was.compactionsPerSession
        ? (now.compactionsPerSession - was.compactionsPerSession) / was.compactionsPerSession
        : (now.compactionsPerSession > 0 ? 1 : 0),
    },
  };
}
