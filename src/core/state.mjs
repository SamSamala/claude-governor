import fs from 'node:fs';
import path from 'node:path';
import { governorDir, projectGovernorDir, projectConfigPath } from './paths.mjs';

/**
 * Tiny persistent state shared between the statusline (sensor) and the hooks (actuators).
 *
 * The bridge exists because of a verified platform gap:
 *   - the statusline RECEIVES rate_limits but only renders to the terminal
 *   - hooks CAN inject context but their payload has NO rate-limit data
 * Neither can implement an 85% trigger alone. The statusline writes; the hook reads.
 *
 * BUG FIXED HERE: this used to be ONE shared file (`limit-state.json`) for every Claude
 * Code window on the machine. With two windows open, each one's statusline overwrote the
 * other's reading every second — the "already notified" latch kept getting wiped by a
 * DIFFERENT session, so the same window fired the handoff protocol repeatedly, and a
 * manual check of the file could show either window's number with no way to tell which.
 * Each session now gets its own file, keyed by `session_id`, so sessions can never step
 * on each other again.
 */

export const CONFIG = 'config.json';
const LIMIT_STATE_PREFIX = 'limit-state-';
const LIMIT_STATE_SUFFIX = '.json';
const LIMIT_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // prune sentinels older than a day

/** Turn a session_id into a safe, unique filename. */
export function limitStateFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return `${LIMIT_STATE_PREFIX}${safe}${LIMIT_STATE_SUFFIX}`;
}

/** Read this session's own rate-limit reading. Never another session's. */
export function readLimitState(sessionId) {
  return readJSON(limitStateFile(sessionId), null);
}

/** Write this session's own rate-limit reading. Never touches another session's file. */
export function writeLimitState(sessionId, value) {
  return writeJSON(limitStateFile(sessionId), value);
}

/** Delete sentinel files old enough that their session is almost certainly gone. */
export function pruneLimitStates(maxAgeMs = LIMIT_STATE_MAX_AGE_MS) {
  try {
    const dir = governorDir();
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(LIMIT_STATE_PREFIX) || !name.endsWith(LIMIT_STATE_SUFFIX)) continue;
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.unlinkSync(full);
      } catch { /* file vanished mid-prune, ignore */ }
    }
  } catch { /* directory missing or unreadable, ignore */ }
}

/**
 * Count how many sessions currently have a sentinel file, for `doctor`.
 * Deliberately does NOT guess which one is "the" current session — a CLI command run
 * outside any live Claude Code window has no way to know which window you mean. The
 * live statusline in that window, or `/usage`, is already the real source of truth;
 * this tool should point there instead of inventing a heuristic to fake an answer.
 */
export function countLimitStates() {
  try {
    return fs.readdirSync(governorDir())
      .filter((n) => n.startsWith(LIMIT_STATE_PREFIX) && n.endsWith(LIMIT_STATE_SUFFIX)).length;
  } catch {
    return 0;
  }
}

/**
 * All current sentinel files with their age, for `verify` (setup proof for non-technical
 * users). Reading these directly is fine for a one-time post-install check — it is not
 * the "which session is mine" guess that `doctor` correctly refuses to make.
 */
export function listLimitStates() {
  const dir = governorDir();
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter((n) => n.startsWith(LIMIT_STATE_PREFIX) && n.endsWith(LIMIT_STATE_SUFFIX));
  } catch {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const name of names) {
    try {
      const full = path.join(dir, name);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      out.push({ ...data, ageMs: now - fs.statSync(full).mtimeMs });
    } catch { /* skip unreadable/partial file */ }
  }
  return out;
}

export const DEFAULT_CONFIG = {
  enabled: true,
  thresholds: { notice: 70, handoff: 85, urgent: 95 },
  guard: { mode: 'advise', maxAdvisoriesPerSession: 6, bigResultTokens: 25_000 },
  window: { sonnet: 0.50, opus: 0.25, haiku: 0.50 },
  wrappedStatusLine: null,
  handoffPath: null,
};

function ensureDir() {
  try {
    fs.mkdirSync(governorDir(), { recursive: true });
  } catch { /* ignore */ }
}

export function readJSON(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(governorDir(), name), 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic-ish write. Never throws — a state write must not break a session. */
export function writeJSON(name, value) {
  try {
    ensureDir();
    const target = path.join(governorDir(), name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a project's local override, if any. Deliberately tiny — just `{ enabled }` — the
 * rest of the config (thresholds, window policy, guard mode) stays global-only. A project
 * override exists only once someone has explicitly run `governor on --project` or
 * `governor off --project` there; most projects never have this file at all.
 */
export function readProjectConfig(cwd) {
  if (!cwd) return null;
  try {
    return JSON.parse(fs.readFileSync(projectConfigPath(cwd), 'utf8'));
  } catch {
    return null;
  }
}

/** Same atomic-write discipline as writeJSON, scoped to the project's own .governor/ dir. */
export function saveProjectConfig(cwd, partial) {
  try {
    const dir = projectGovernorDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const target = projectConfigPath(cwd);
    let current = {};
    try { current = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { /* none yet */ }
    const next = { ...current, ...partial };
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * `loadConfig(cwd)` — global config, with a project-level `enabled` override applied on top
 * when `cwd` is given and a project override file exists. Callers with no notion of "current
 * project" (most CLI commands) call this with no argument and get pure global behavior,
 * unchanged. Hooks and the statusline — which DO know the current project from their
 * payload — pass `cwd` so a project-scoped `governor off --project` actually silences them
 * there without touching any other project or the global default.
 */
export function loadConfig(cwd) {
  const c = readJSON(CONFIG, null);
  const merged = (!c || typeof c !== 'object')
    ? { ...DEFAULT_CONFIG }
    : {
      ...DEFAULT_CONFIG,
      ...c,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...(c.thresholds || {}) },
      guard: { ...DEFAULT_CONFIG.guard, ...(c.guard || {}) },
      window: { ...DEFAULT_CONFIG.window, ...(c.window || {}) },
    };

  const proj = readProjectConfig(cwd);
  if (proj && typeof proj.enabled === 'boolean') {
    merged.enabled = proj.enabled;
    merged.projectOverride = true;
  }
  return merged;
}

export function saveConfig(c) {
  return writeJSON(CONFIG, c);
}
