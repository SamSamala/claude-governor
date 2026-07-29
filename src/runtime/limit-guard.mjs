#!/usr/bin/env node
/**
 * Governor limit guard — the actuator half of the bridge.
 *
 * PostToolBatch fires after a batch of tool calls resolves, before the next model
 * request, and can return `additionalContext`. It receives NO rate-limit data, so it
 * reads what the statusline sensor wrote for THIS session's own sentinel file.
 *
 * Reads by session_id, never a file shared with other Claude Code windows — a shared
 * file let one window's write erase another's "already notified" latch, causing repeat
 * firing and readings that belonged to whichever window wrote last.
 *
 * Latched: fires at most once per 5-hour window (keyed on resets_at) so it never nags
 * and never loops. Silent and harmless when rate_limits are unavailable (API users,
 * or before the first API response).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, readLimitState, writeLimitState } from '../core/state.mjs';

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolBatch',
      additionalContext: context,
    },
  }));
}

function handoffPath(cwd) {
  return path.join(cwd || process.cwd(), 'HANDOFF.md');
}

function protocolMessage(state, cwd) {
  const resetMin = state.resetsAt
    ? Math.max(0, Math.round((state.resetsAt - Date.now() / 1000) / 60))
    : null;
  return [
    `<governor-limit-protocol>`,
    `The 5-hour usage window is at ${state.usedPercentage.toFixed(0)}%` +
      (resetMin !== null ? ` and resets in ~${resetMin} minutes.` : '.'),
    ``,
    `Stop expanding scope. Before the window runs out, write a handoff to ${handoffPath(cwd)} containing:`,
    `  1. GOAL — what we are trying to achieve and what "done" means.`,
    `  2. DONE — what is already finished and verified. Be specific; this is what must NOT be redone.`,
    `  3. DECISIONS — choices made and the reason, so they are not relitigated.`,
    `  4. FILES — the files that matter, with one line each on their role.`,
    `  5. NEXT — the single exact next action, concrete enough to start cold.`,
    `  6. AVOID — dead ends already ruled out.`,
    ``,
    `Keep it under ~2000 tokens. It replaces replaying this conversation, so it must be`,
    `self-contained but not a transcript. Write it now, finish or safely park the current`,
    `step, then tell the user it is safe to /clear — the next session will load it automatically.`,
    `</governor-limit-protocol>`,
  ].join('\n');
}

function noticeMessage(state) {
  return [
    `<governor-notice>`,
    `5-hour usage window at ${state.usedPercentage.toFixed(0)}%. Prefer finishing the current`,
    `thread over starting new investigation. Keep large tool results bounded.`,
    `</governor-notice>`,
  ].join('\n');
}

function main() {
  const raw = readStdin();
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* fall through */ }

  const cfg = loadConfig();
  if (cfg.enabled === false) return;

  const sessionId = payload?.session_id;
  if (!sessionId) return; // cannot scope to a session, so say nothing rather than guess whose data this is

  const state = readLimitState(sessionId);
  // No sensor data yet for THIS session, or the subscription fields are absent entirely.
  if (!state || !state.available || typeof state.usedPercentage !== 'number') return;

  // Stale sensor data (statusline not running) — say nothing rather than guess.
  if (Date.now() - (state.updatedAt || 0) > 5 * 60_000) return;

  const used = state.usedPercentage;
  const { notice, handoff } = cfg.thresholds;
  const windowKey = state.resetsAt ?? 'unknown';

  if (used >= handoff && state.firedFor !== windowKey) {
    writeLimitState(sessionId, { ...state, firedFor: windowKey, noticedFor: windowKey });
    emit(protocolMessage(state, payload?.cwd));
    return;
  }

  if (used >= notice && used < handoff && state.noticedFor !== windowKey) {
    writeLimitState(sessionId, { ...state, noticedFor: windowKey });
    emit(noticeMessage(state));
  }
}

try {
  main();
} catch {
  // A hook failure must never break the agentic loop.
}
process.exit(0);
