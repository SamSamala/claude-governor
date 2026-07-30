import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, settingsPath, governorDir } from './paths.mjs';
import { computeWindow, envOverride, isAcceptable } from './policy.mjs';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from './state.mjs';
import { AGENTS, SKILLS } from './templates.mjs';
import {
  upsertBlock, removeBlock, hasBlock,
  PLAN_MODE_ID, PLAN_MODE_BLOCK, MISTAKES_ID, MISTAKES_BLOCK,
} from './claudemd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const RUNTIME_DIR = path.join(SRC, 'runtime');
const DEFAULT_STATUSLINE_SCRIPT = path.join(SRC, 'assets', 'default-statusline.sh');
const MARK = 'governor';

const runtime = (f) => path.join(RUNTIME_DIR, f);
const claudeMdPath = () => path.join(configDir(), 'CLAUDE.md');
/**
 * Use the ABSOLUTE path to the node binary that ran this installer (`process.execPath`),
 * never the bare word "node". Non-technical users often have node installed via Homebrew
 * or nvm, and a GUI-launched Claude Code process can have a different, minimal PATH than
 * a terminal — the bare command then fails silently and the hook never produces output.
 * An absolute path has no PATH-resolution step, so it can't hit that failure mode.
 */
const nodeCmd = (f) => `"${process.execPath}" "${runtime(f)}"`;

/**
 * Recognise our own entries so install is idempotent and uninstall is complete.
 *
 * Must NOT be a case-sensitive substring test: the package may live in a directory
 * like `ClaudeGovernor`, or anywhere at all. We match the absolute runtime path first
 * (exact for this install) and fall back to a case-insensitive name match.
 */
function isOurs(cmd) {
  if (typeof cmd !== 'string') return false;
  return cmd.includes(RUNTIME_DIR) || cmd.toLowerCase().includes(MARK);
}

/* ------------------------------------------------------------------ probing */

/**
 * Capability probe. Nothing is assumed to exist; anything unverified degrades and is
 * REPORTED rather than silently skipped.
 */
export function probe() {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });

  add('config directory', fs.existsSync(configDir()), configDir());

  let settings = null, settingsReadable = false;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settingsReadable = true;
  } catch (e) {
    settings = fs.existsSync(settingsPath()) ? null : {};
    settingsReadable = !fs.existsSync(settingsPath());
  }
  add('settings.json readable', settingsReadable,
    settingsReadable ? settingsPath() : `unparseable: ${settingsPath()}`);

  const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
  add('node >= 18', nodeOk, `v${process.versions.node}`);

  const plat = process.platform;
  add('supported platform', plat === 'darwin' || plat === 'linux', plat);

  const env = envOverride();
  add('no env override of autoCompactWindow', !env, env ? env.message : 'clear');

  const existingHooks = settings?.hooks ? Object.keys(settings.hooks).length : 0;
  add('existing hooks preserved', true, `${existingHooks} hook event(s) present`);

  const sl = settings?.statusLine?.command;
  add('existing statusLine detected', true,
    sl ? (isOurs(sl) ? 'already Governor (will not re-wrap)' : `will wrap: ${sl}`) : 'none');

  const hasPlanBlock = hasBlock(claudeMdPath(), PLAN_MODE_ID);
  add('existing CLAUDE.md detected', true,
    fs.existsSync(claudeMdPath())
      ? (hasPlanBlock ? 'already has the Governor Plan Mode rule' : 'will append to it')
      : 'none — will be created');

  return { results, settings: settings || {}, ok: results.every((r) => r.ok || r.name === 'no env override of autoCompactWindow') };
}

/* ------------------------------------------------------------------ merging */

function withoutOurs(list) {
  return (Array.isArray(list) ? list : []).filter((entry) => {
    const hooks = entry?.hooks;
    if (!Array.isArray(hooks)) return true;
    return !hooks.some((h) => isOurs(h?.command));
  });
}

/** Add our hook to an event WITHOUT touching anyone else's. Idempotent. */
function mergeHook(settings, event, matcher, file) {
  settings.hooks ||= {};
  const kept = withoutOurs(settings.hooks[event]);
  const entry = { hooks: [{ type: 'command', command: nodeCmd(file) }] };
  if (matcher) entry.matcher = matcher;
  settings.hooks[event] = [...kept, entry];
}

function removeOurHooks(settings) {
  if (!settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    const kept = withoutOurs(settings.hooks[event]);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

/* ------------------------------------------------------------------ writing */

function backup() {
  try {
    if (!fs.existsSync(settingsPath())) return null;
    const dst = path.join(governorDir(), `settings.backup.${Date.now()}.json`);
    fs.mkdirSync(governorDir(), { recursive: true });
    fs.copyFileSync(settingsPath(), dst);
    return dst;
  } catch {
    return null;
  }
}

function writeSettings(settings) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

function writeArtifacts() {
  const written = [];
  const agentsDir = path.join(configDir(), 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const [file, body] of Object.entries(AGENTS)) {
    const p = path.join(agentsDir, file);
    // Namespaced gv-*; if a same-named file exists that is not ours, do not clobber it.
    if (fs.existsSync(p)) {
      const cur = fs.readFileSync(p, 'utf8');
      if (!cur.includes('name: gv-')) { written.push({ path: p, skipped: 'name collision' }); continue; }
    }
    fs.writeFileSync(p, body);
    written.push({ path: p });
  }

  for (const [name, body] of Object.entries(SKILLS)) {
    const dir = path.join(configDir(), 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'SKILL.md');
    fs.writeFileSync(p, body);
    written.push({ path: p });
  }
  return written;
}

/* ------------------------------------------------------------------ install */

export function install({ model, dryRun = false } = {}) {
  const p = probe();
  const settings = { ...p.settings };
  const notes = [];
  const warnings = [];

  const targetModel = model || settings.model || 'claude-sonnet-5';
  // Force enabled:true even if a PRIOR uninstall left enabled:false persisted — running
  // `install` is an unambiguous request to be on. Without this, uninstall -> reinstall
  // silently stays OFF forever, because uninstall() itself sets enabled:false to record
  // that stopped state, and a naive merge below would just carry it forward.
  const cfg = { ...DEFAULT_CONFIG, ...loadConfig(), enabled: true };

  // ---- Tier 1: the window policy (largest measured lever)
  const decision = computeWindow(targetModel, { pct: cfg.window });
  warnings.push(...decision.warnings);

  if (!isAcceptable(decision.value)) {
    throw new Error(
      `Refusing to write autoCompactWindow=${decision.value}: outside the accepted range. ` +
      `Claude Code would silently discard it.`
    );
  }

  const before = settings.autoCompactWindow;
  settings.autoCompactWindow = decision.value;
  settings.autoCompactEnabled = true;
  settings.precomputeCompactionEnabled = true;
  settings.skillListingMaxDescChars ??= 800;
  settings.skillListingBudgetFraction ??= 0.008;

  notes.push(
    `autoCompactWindow ${before ?? '(auto)'} -> ${decision.value.toLocaleString('en-US')} ` +
    `(${Math.round(decision.fraction * 100)}% of ${decision.modelWindow.toLocaleString('en-US')} for ${decision.family}); ` +
    `compaction should fire near ~${Math.round(decision.value * 0.42).toLocaleString('en-US')} tokens.`
  );

  // ---- statusLine: wrap, never replace
  const currentSL = settings.statusLine?.command;
  if (currentSL && !isOurs(currentSL)) {
    cfg.wrappedStatusLine = currentSL;
    notes.push(`wrapping existing statusLine (preserved): ${currentSL}`);
  } else if (!currentSL) {
    // True vanilla: nothing to preserve, so give a real statusline instead of a bare one —
    // a polished bar-based line (dir/model/ctx/5h/git), not Governor's own minimal text.
    const dst = path.join(governorDir(), 'default-statusline.sh');
    fs.mkdirSync(governorDir(), { recursive: true });
    fs.copyFileSync(DEFAULT_STATUSLINE_SCRIPT, dst);
    fs.chmodSync(dst, 0o755);
    cfg.wrappedStatusLine = `bash "${dst}"`;
    notes.push('no statusline existed, so a default one (dir/model/ctx/5h/git) was installed');
  }
  settings.statusLine = {
    type: 'command',
    command: nodeCmd('statusline.mjs'),
    refreshInterval: settings.statusLine?.refreshInterval ?? 2,
    ...(settings.statusLine?.padding !== undefined ? { padding: settings.statusLine.padding } : {}),
  };

  // ---- hooks
  // Purge OUR hooks from every event first, then re-add the current set. Without this a
  // renamed event leaves an orphan behind forever: `PostToolUseBatch` was registered before
  // we learned the real name is `PostToolBatch`, and the dead entry survived reinstalls.
  removeOurHooks(settings);
  mergeHook(settings, 'PreToolUse', 'Read|Grep|Bash', 'guard.mjs');
  mergeHook(settings, 'PostToolBatch', null, 'limit-guard.mjs');
  mergeHook(settings, 'SessionStart', null, 'session-start.mjs');

  notes.push(
    'Added a short rule to your global CLAUDE.md: Plan Mode must produce a step-by-step ' +
    'execution plan (commands, files, order, config) and predict failures only where a ' +
    'real one is likely — not for every possible error.'
  );
  notes.push(
    'Added a second rule to your global CLAUDE.md: before debugging a new error, check ' +
    'MISTAKES.md in the project for a prior instance of it; log real fixes there so the ' +
    'same mistake is not solved twice.'
  );

  if (dryRun) {
    return { dryRun: true, decision, settings, notes, warnings, probe: p.results };
  }

  const backupPath = backup();
  try {
    writeSettings(settings);
    saveConfig(cfg);
    const artifacts = writeArtifacts();
    upsertBlock(claudeMdPath(), PLAN_MODE_ID, PLAN_MODE_BLOCK);
    upsertBlock(claudeMdPath(), MISTAKES_ID, MISTAKES_BLOCK);

    // ---- read-back assert: the whole point. A written value that did not stick is a
    //      silent failure, which is the failure mode this project exists to prevent.
    const readBack = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (readBack.autoCompactWindow !== decision.value) {
      throw new Error(`read-back mismatch: expected ${decision.value}, found ${readBack.autoCompactWindow}`);
    }
    if (!isOurs(readBack.statusLine?.command)) {
      throw new Error('read-back mismatch: statusLine did not persist');
    }
    if (!hasBlock(claudeMdPath(), PLAN_MODE_ID)) {
      throw new Error('read-back mismatch: CLAUDE.md Plan Mode rule did not persist');
    }
    if (!hasBlock(claudeMdPath(), MISTAKES_ID)) {
      throw new Error('read-back mismatch: CLAUDE.md mistake-log rule did not persist');
    }

    return { decision, notes, warnings, artifacts, backupPath, probe: p.results };
  } catch (err) {
    if (backupPath) {
      try {
        fs.copyFileSync(backupPath, settingsPath());
        warnings.push(`Install failed; settings.json restored from ${backupPath}`);
      } catch { /* nothing more we can do */ }
    }
    throw err;
  }
}

/* ---------------------------------------------------------------- uninstall */

export function uninstall() {
  const backupPath = backup();
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { /* ignore */ }

  const cfg = loadConfig();
  removeOurHooks(settings);

  // If the "previous" statusline is actually our own shipped default script, there was
  // never a real one to restore — go back to true vanilla (no statusLine key at all)
  // instead of leaving the user pointed at a leftover Governor file.
  const wasOurDefault = cfg.wrappedStatusLine && cfg.wrappedStatusLine.includes(DEFAULT_STATUSLINE_SCRIPT.split('/').pop());
  if (isOurs(settings.statusLine?.command)) {
    if (cfg.wrappedStatusLine && !wasOurDefault) {
      settings.statusLine = { type: 'command', command: cfg.wrappedStatusLine, refreshInterval: 1 };
    } else {
      delete settings.statusLine;
    }
  }
  delete settings.autoCompactWindow;

  writeSettings(settings);
  saveConfig({ ...cfg, enabled: false });
  removeBlock(claudeMdPath(), PLAN_MODE_ID);
  removeBlock(claudeMdPath(), MISTAKES_ID);
  if (wasOurDefault) {
    try { fs.unlinkSync(path.join(governorDir(), 'default-statusline.sh')); } catch { /* already gone */ }
  }
  return { backupPath, restoredStatusLine: wasOurDefault ? null : (cfg.wrappedStatusLine || null) };
}
