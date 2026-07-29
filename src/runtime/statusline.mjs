#!/usr/bin/env node
/**
 * Governor statusline — the free sensor.
 *
 * Runs ~1x/second. Rendered in the terminal and NEVER sent to the model: zero tokens.
 * It is the only surface that receives `rate_limits`, so it is also where the
 * 5-hour window is observed and written to disk for the hooks to act on.
 *
 * Hard rules:
 *   - Never parse the transcript. The payload already carries context_window.* —
 *     re-reading a 24MB file once per second would be a self-inflicted wound.
 *   - Never crash. Any failure prints nothing (or the wrapped line) and exits 0.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig, readLimitState, writeLimitState, pruneLimitStates } from '../core/state.mjs';
import { computeWindow } from '../core/policy.mjs';

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m';
const YEL = '\x1b[33m', RED = '\x1b[31m', GRN = '\x1b[32m', CYAN = '\x1b[36m';

/** Bold state word in its color, dim connective text, the command itself bold+cyan so it
 * visually stands out as something to type — not just more descriptive prose. */
function toggleLabel(isOn) {
  const word = isOn
    ? `${BOLD}${GRN}Governor ON${RESET}`
    : `${BOLD}${RED}Governor OFF${RESET}`;
  const cmd = isOn ? 'governor off' : 'governor on';
  const verb = isOn ? 'disable' : 'enable';
  return `${word}${DIM} — run ${RESET}${BOLD}${CYAN}${cmd}${RESET}${DIM} to ${verb}${RESET}`;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function pctColor(p, warn, bad) {
  if (p >= bad) return RED;
  if (p >= warn) return YEL;
  return GRN;
}

function fmtTok(n) {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function fmtResetIn(epochSec) {
  if (!epochSec) return '';
  const secs = epochSec - Math.floor(Date.now() / 1000);
  if (secs <= 0) return 'now';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/**
 * Record what we saw so the hooks (which get no rate-limit data) can act.
 *
 * Scoped to THIS session's own file (keyed by session_id) — never shared with any other
 * Claude Code window. Two windows open at once used to overwrite one shared file every
 * second, which broke the "already notified" latch and made a manual check of the file
 * show whichever window wrote last, not a trustworthy reading. Per-session files fix both.
 *
 * Latched per window: `firedFor` holds the resets_at we already fired on, so the
 * protocol triggers ONCE per 5-hour window instead of on every tool call.
 */
function updateLimitState(payload, cfg) {
  const sessionId = payload?.session_id ?? null;
  const five = payload?.rate_limits?.five_hour;
  const week = payload?.rate_limits?.seven_day;
  const prev = (sessionId && readLimitState(sessionId)) || {};
  const used = typeof five?.used_percentage === 'number' ? five.used_percentage : null;
  const resetsAt = typeof five?.resets_at === 'number' ? five.resets_at : null;
  const weekUsed = typeof week?.used_percentage === 'number' ? week.used_percentage : null;
  const weekResetsAt = typeof week?.resets_at === 'number' ? week.resets_at : null;

  // A new window invalidates any previous latch.
  const sameWindow = prev.resetsAt && resetsAt && prev.resetsAt === resetsAt;
  const firedFor = sameWindow ? prev.firedFor ?? null : null;

  const ctx = payload?.context_window || {};
  const state = {
    updatedAt: Date.now(),
    sessionId,
    available: used !== null,
    usedPercentage: used,
    resetsAt,
    firedFor,
    weekAvailable: weekUsed !== null,
    weekUsedPercentage: weekUsed,
    weekResetsAt,
    contextUsedPercentage: typeof ctx.used_percentage === 'number' ? ctx.used_percentage : null,
    contextTokens: typeof ctx.total_input_tokens === 'number' ? ctx.total_input_tokens : null,
    contextWindowSize: typeof ctx.context_window_size === 'number' ? ctx.context_window_size : null,
    model: payload?.model?.id ?? null,
    effort: payload?.effort?.level ?? null,
    thresholds: cfg.thresholds,
  };
  if (sessionId) writeLimitState(sessionId, state);
  return state;
}

/**
 * Render only what the user's own statusline is not already showing.
 *
 * Observed in practice: many custom statuslines already display context and the 5-hour
 * window. Repeating them is noise. The genuinely additive facts are where compaction will
 * fire and the threshold warnings — everything else is suppressed when we are wrapping.
 */
function render(payload, cfg, state, wrappedText = '') {
  const parts = [];
  // Strip ANSI first: escape codes sit flush against the words ("\x1b[90mCtx"), which
  // destroys \b word boundaries and silently defeats duplicate detection.
  const plain = String(wrappedText).replace(/\x1b\[[0-9;]*m/g, '');
  const already = (re) => re.test(plain);
  const mode = cfg.render || 'auto';
  const terse = mode === 'auto' ? Boolean(wrappedText) : mode === 'compact';

  // Context pressure, relative to where compaction will actually bite.
  const ctx = payload?.context_window || {};
  if (typeof ctx.total_input_tokens === 'number' && !(terse && already(/\bctx\b/i))) {
    const tok = ctx.total_input_tokens;
    const p = typeof ctx.used_percentage === 'number' ? ctx.used_percentage : 0;
    parts.push(`${pctColor(p, 50, 80)}ctx ${fmtTok(tok)}${RESET}`);
  }

  // The 5-hour window — the thing Claude Code otherwise ignores entirely.
  if (state.available) {
    const p = state.usedPercentage;
    const c = pctColor(p, cfg.thresholds.notice, cfg.thresholds.handoff);
    const resets = fmtResetIn(state.resetsAt);
    if (!(terse && already(/\b5h\b/i))) {
      parts.push(`${c}5h ${p.toFixed(0)}%${RESET}${resets ? `${DIM}/${resets}${RESET}` : ''}`);
    }
    // Warnings are never suppressed — they are the point.
    if (p >= cfg.thresholds.handoff) parts.push(`${RED}⚑ handoff${RESET}`);
    else if (p >= cfg.thresholds.notice) parts.push(`${YEL}⚠ ${p.toFixed(0)}%${RESET}`);
  }

  // The 7-day window — same idea, longer horizon. Suppressed if the wrapped line already
  // shows one under either label ("week" or "7d" — e.g. a script with its own 7d bar).
  if (state.weekAvailable && !(terse && already(/\b(week|7d)\b/i))) {
    const wp = state.weekUsedPercentage;
    const wc = pctColor(wp, cfg.thresholds.notice, cfg.thresholds.handoff);
    const wResets = fmtResetIn(state.weekResetsAt);
    parts.push(`${wc}week ${wp.toFixed(0)}%${RESET}${wResets ? `${DIM}/${wResets}${RESET}` : ''}`);
  }

  // Where compaction is configured to fire, so the setting is never invisible.
  if (state.model) {
    try {
      const d = computeWindow(state.model, {
        observedWindow: state.contextWindowSize,
        pct: cfg.window,
      });
      parts.push(`${DIM}cmp~${fmtTok(Math.round(d.value * 0.42))}${RESET}`);
    } catch { /* never break the line */ }
  }

  if (payload?.effort?.level && !(terse && already(/\b(low|medium|high|xhigh|max)\b/)))
    parts.push(`${DIM}${payload.effort.level}${RESET}`);

  // Real, not decorative: this function only runs when cfg.enabled is true (see main()),
  // so reaching this line IS the proof. The OFF case is rendered separately in main(),
  // where Governor has stopped doing anything but still owns the statusline command.
  parts.push(toggleLabel(true));

  return parts.join(` ${DIM}·${RESET} `);
}

/** Run the statusline we replaced, so installing Governor never costs the user their setup. */
function wrapped(cfg, raw) {
  const cmd = cfg.wrappedStatusLine;
  if (!cmd || typeof cmd !== 'string') return '';
  try {
    const r = spawnSync(process.env.SHELL || '/bin/sh', ['-c', cmd], {
      input: raw,
      encoding: 'utf8',
      timeout: 1500,
    });
    return (r.stdout || '').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

/**
 * Combine the wrapped statusline with Governor's own line, as SEPARATE LINES rather than
 * one long line — a wrapped script is often already a full line on its own (dir/model/ctx/
 * etc.), and appending more text to its end just gets truncated or wraps ugly in a narrow
 * terminal. Governor's line goes right after the wrapped script's own first line, so it
 * reads as "your line, then ours" — never inserted mid-way through multi-line output.
 */
function stack(theirs, mine) {
  if (!theirs) return mine;
  if (!mine) return theirs;
  const lines = String(theirs).split('\n');
  lines.splice(1, 0, mine);
  return lines.join('\n');
}

function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch { /* render what little we can */ }

  const cfg = loadConfig();
  if (cfg.enabled === false) {
    // Soft-disabled via `governor off`: stop touching state/hooks entirely, but say so —
    // a silently-vanished tool looks identical to a broken one. `governor on` reverses it.
    const w = wrapped(cfg, raw);
    const off = toggleLabel(false);
    process.stdout.write(stack(w, off));
    return;
  }

  const state = updateLimitState(payload, cfg);
  // Cheap, rare cleanup of other sessions' old sentinel files — not every tick (runs ~1x/sec).
  if (Math.random() < 1 / 300) pruneLimitStates();
  const theirs = wrapped(cfg, raw);          // run first: render() suppresses duplicates
  const mine = render(payload, cfg, state, theirs);

  if (theirs || mine) process.stdout.write(stack(theirs, mine));
}

try {
  main();
} catch {
  // A statusline crash must never be visible or fatal.
}
process.exit(0);
