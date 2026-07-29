#!/usr/bin/env node
/**
 * Governor admission guard — PreToolUse.
 *
 * Targets the measured problem: 7% of tool results carry 87% of all tool tokens, and
 * their real cost is `size x turns_remaining` (one 166k screenshot cost ~$230 because it
 * was re-read 922 times).
 *
 * Design rules, in priority order:
 *   1. NEVER rewrite `updatedInput`. Silent semantic change breaks arbitrary tasks
 *      invisibly, which is the one failure we refuse to ship.
 *   2. Advisory by default — inject context, let the model decide. `enforce` is opt-in.
 *   3. Near-zero false positives. Only fire when the call is PROVABLY unbounded.
 *      An advisory on an already-bounded call trains the user to uninstall.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, readJSON, writeJSON } from '../core/state.mjs';

const COUNTER = 'guard-count.json';
const BIG_FILE_BYTES = 120_000; // ~30k tokens

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Commands whose output is routinely enormous and repetitive. */
const NOISY_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck)\b|\b(tsc|jest|vitest|pytest|cargo\s+(build|test)|go\s+test|make|gradle|mvn|webpack|next\s+build)\b/;
/** Evidence the caller already bounded the output. */
const BOUNDED = /\|\s*(head|tail|wc|grep|rg|jq|sed|awk)\b|>\s*\/dev\/null|--silent\b|--quiet\b|-q\b|2>&1\s*\|\s*(head|tail)|\|\s*head\b/;

function checkRead(input) {
  if (input?.limit || input?.offset) return null; // already bounded
  const p = input?.file_path;
  if (typeof p !== 'string') return null;
  let size = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null; // can't prove anything
  }
  if (size < BIG_FILE_BYTES) return null;
  const approx = Math.round(size / 4 / 1000);
  return `Reading ${path.basename(p)} in full will admit roughly ${approx}k tokens, and it stays in context for every remaining turn of this session. If you only need part of it, pass \`offset\`/\`limit\`, or grep for the region first. If you genuinely need the whole file, proceed.`;
}

function checkGrep(input) {
  if (input?.head_limit) return null;
  const mode = input?.output_mode || 'files_with_matches';
  if (mode !== 'content') return null;              // counts/filenames are small
  if (input?.path && /\.[a-z]+$/i.test(input.path)) return null; // single file, bounded enough
  return `This grep returns full matching lines with no \`head_limit\`. On a large tree that can admit tens of thousands of tokens which then persist for the rest of the session. Consider \`head_limit\`, or \`output_mode: "files_with_matches"\` first to scope it.`;
}

function checkBash(input) {
  const cmd = input?.command;
  if (typeof cmd !== 'string') return null;
  if (BOUNDED.test(cmd)) return null;   // caller already bounded it
  if (!NOISY_CMD.test(cmd)) return null;
  return `Build/test output is typically large, repetitive, and mostly irrelevant once it has been read — but it stays in context for every remaining turn. Consider piping through \`tail -40\`, \`2>&1 | tail -60\`, or a quiet flag. If you need the full log, proceed.`;
}

const CHECKS = { Read: checkRead, Grep: checkGrep, Bash: checkBash };

function bump(sessionId, max) {
  const all = readJSON(COUNTER, {}) || {};
  const key = sessionId || 'unknown';
  const now = Date.now();
  // drop entries older than a day so this file never grows
  for (const k of Object.keys(all)) {
    if (now - (all[k]?.t || 0) > 86_400_000) delete all[k];
  }
  const cur = all[key]?.n || 0;
  if (cur >= max) return false;
  all[key] = { n: cur + 1, t: now };
  writeJSON(COUNTER, all);
  return true;
}

function main() {
  const raw = readStdin();
  let payload = {};
  try { payload = JSON.parse(raw); } catch { return; }

  const cfg = loadConfig();
  if (cfg.enabled === false) return;

  const tool = payload?.tool_name;
  const check = CHECKS[tool];
  if (!check) return;

  const advice = check(payload?.tool_input || {});
  if (!advice) return;

  if (!bump(payload?.session_id, cfg.guard.maxAdvisoriesPerSession)) return;

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `<governor-guard tool="${tool}">${advice}</governor-guard>`,
    },
  };

  // Opt-in only. Default never blocks.
  if (cfg.guard.mode === 'enforce') {
    out.hookSpecificOutput.permissionDecision = 'ask';
    out.hookSpecificOutput.permissionDecisionReason = advice;
  }

  process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch {
  // Never block a tool call.
}
process.exit(0);
