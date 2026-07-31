import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RT = path.resolve(HERE, '..', 'src', 'runtime');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-rt-'));
  fs.mkdirSync(path.join(dir, 'governor'), { recursive: true });
  return dir;
}

/** Run a hook with an isolated config dir. Returns stdout. */
function run(script, payload, cfgDir, env = {}) {
  return execFileSync(process.execPath, [path.join(RT, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir, ...env },
  });
}

/** Each session gets its own sentinel file now — read the specific session's. */
const limitState = (dir, sessionId) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'governor', `limit-state-${sessionId}.json`), 'utf8')); }
  catch { return null; }
};

/* ------------------------------------------------------------------- GATE 2 */

test('GATE 2 — statusline senses the 5-hour window and writes the sentinel', () => {
  const dir = sandbox();
  const out = run('statusline.mjs', {
    session_id: 's1',
    model: { id: 'claude-opus-5' },
    context_window: { total_input_tokens: 120_000, used_percentage: 12, context_window_size: 1_000_000 },
    rate_limits: { five_hour: { used_percentage: 86, resets_at: 2_000_000_000 } },
  }, dir);

  const st = limitState(dir, 's1');
  assert.ok(st, 'sentinel written');
  assert.equal(st.available, true);
  assert.equal(st.usedPercentage, 86);
  assert.equal(st.resetsAt, 2_000_000_000);
  assert.match(out, /5h 86%/, 'renders the window to the terminal');
});

test('GATE 2 — the hook fires the handoff protocol exactly ONCE per window', () => {
  const dir = sandbox();
  run('statusline.mjs', {
    session_id: 's1',
    rate_limits: { five_hour: { used_percentage: 90, resets_at: 2_000_000_000 } },
  }, dir);

  const first = run('limit-guard.mjs', { cwd: '/tmp/proj', session_id: 's1' }, dir);
  assert.ok(first.length > 0, 'fires at 90%');
  const parsed = JSON.parse(first);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolBatch');
  assert.match(parsed.hookSpecificOutput.additionalContext, /governor-limit-protocol/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /HANDOFF\.md/);

  // Latched: a second call in the same window must stay silent, or it would nag every batch.
  const second = run('limit-guard.mjs', { cwd: '/tmp/proj', session_id: 's1' }, dir);
  assert.equal(second.trim(), '', 'does not re-fire in the same window');
});

test('GATE 2 — a new window (new resets_at) re-arms the latch', () => {
  const dir = sandbox();
  const sid = 's2';
  run('statusline.mjs', { session_id: sid, rate_limits: { five_hour: { used_percentage: 90, resets_at: 1000 } } }, dir);
  assert.ok(run('limit-guard.mjs', { session_id: sid }, dir).length > 0);
  assert.equal(run('limit-guard.mjs', { session_id: sid }, dir).trim(), '');

  run('statusline.mjs', { session_id: sid, rate_limits: { five_hour: { used_percentage: 91, resets_at: 9999 } } }, dir);
  assert.ok(run('limit-guard.mjs', { session_id: sid }, dir).length > 0, 'fires again in the next window');
});

test('GATE 2 — below the threshold nothing fires; the notice tier fires once', () => {
  const dir = sandbox();
  const sid = 's3';
  run('statusline.mjs', { session_id: sid, rate_limits: { five_hour: { used_percentage: 40, resets_at: 5 } } }, dir);
  assert.equal(run('limit-guard.mjs', { session_id: sid }, dir).trim(), '', 'silent at 40%');

  run('statusline.mjs', { session_id: sid, rate_limits: { five_hour: { used_percentage: 75, resets_at: 5 } } }, dir);
  const notice = run('limit-guard.mjs', { session_id: sid }, dir);
  assert.match(notice, /governor-notice/, 'advisory at 75%');
  assert.equal(run('limit-guard.mjs', { session_id: sid }, dir).trim(), '', 'notice does not repeat');
});

test('GATE 2 — self-disables when rate_limits are absent (API users)', () => {
  const dir = sandbox();
  run('statusline.mjs', { session_id: 'x', context_window: { total_input_tokens: 5000 } }, dir);
  const st = limitState(dir, 'x');
  assert.equal(st.available, false);
  assert.equal(run('limit-guard.mjs', { session_id: 'x' }, dir).trim(), '', 'never fires without data');
});

test('BUG REGRESSION — two Claude Code windows open at once must not clobber each other', () => {
  // This is the exact bug reported live: two sessions sharing one sentinel file meant
  // one window's write erased the other's "already notified" latch, and a manual check
  // of the file showed whichever session wrote last, not a trustworthy reading.
  const dir = sandbox();
  run('statusline.mjs', { session_id: 'window-A', rate_limits: { five_hour: { used_percentage: 98, resets_at: 111 } } }, dir);
  run('statusline.mjs', { session_id: 'window-B', rate_limits: { five_hour: { used_percentage: 3, resets_at: 999 } } }, dir);

  const a = limitState(dir, 'window-A');
  const b = limitState(dir, 'window-B');
  assert.equal(a.usedPercentage, 98, 'window A keeps its own reading');
  assert.equal(b.usedPercentage, 3, 'window B keeps its own reading, unaffected by A');

  // A's latch must not be wiped by B's writes.
  const fired = run('limit-guard.mjs', { session_id: 'window-A' }, dir);
  assert.ok(fired.length > 0, 'A still fires on its own 98%');
  const again = run('limit-guard.mjs', { session_id: 'window-A' }, dir);
  assert.equal(again.trim(), '', 'A stays latched even though B kept writing in between');

  // B, at 3%, must never fire — it must not inherit A's state.
  assert.equal(run('limit-guard.mjs', { session_id: 'window-B' }, dir).trim(), '', 'B never fires');
});

/* ------------------------------------------------------------------- GATE 3 */

test('GATE 3 — warm restart injects the handoff and stays inside the startup budget', () => {
  const dir = sandbox();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-proj-'));
  fs.writeFileSync(path.join(proj, 'HANDOFF.md'), '# Handoff\n\n## NEXT\nRun the migration.\n');

  const out = run('session-start.mjs', { source: 'startup', cwd: proj }, dir);
  const parsed = JSON.parse(out);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Run the migration/);
  assert.match(ctx, /governor-handoff/);
  assert.equal(parsed.hookSpecificOutput.reloadSkills, true);
  assert.ok(ctx.length < 8000 + 2000, 'startup injection stays ~2k tokens, not a history replay');
});

test('GATE 3 — a completed handoff is not resurrected', () => {
  const dir = sandbox();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-proj-'));
  fs.writeFileSync(path.join(proj, 'HANDOFF.md'), '<!-- governor:done -->\n# Handoff\nold work\n');
  assert.equal(run('session-start.mjs', { source: 'startup', cwd: proj }, dir).trim(), '');
});

test('GATE 3 — resume is skipped (history is already present)', () => {
  const dir = sandbox();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-proj-'));
  fs.writeFileSync(path.join(proj, 'HANDOFF.md'), '# Handoff\nstuff\n');
  assert.equal(run('session-start.mjs', { source: 'resume', cwd: proj }, dir).trim(), '');
});

/* -------------------------------------------------------------- guard precision */

test('guard advises on an unbounded Read of a large file', () => {
  const dir = sandbox();
  const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-big-')), 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(300_000));

  const out = run('guard.mjs', { tool_name: 'Read', session_id: 'g1', tool_input: { file_path: big } }, dir);
  assert.match(out, /governor-guard/);
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /offset.*limit|limit/);
});

test('a project-level override silences guard.mjs for that project only, via payload.cwd', async () => {
  const dir = sandbox();
  const { saveProjectConfig } = await import(`../src/core/state.mjs?v=${Math.random()}`);
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-projA-'));
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-projB-'));
  saveProjectConfig(projA, { enabled: false });

  const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-big-')), 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(300_000));

  const silenced = run('guard.mjs',
    { tool_name: 'Read', session_id: 'g1', cwd: projA, tool_input: { file_path: big } }, dir);
  assert.equal(silenced, '', 'project A is off — guard says nothing');

  const stillWorks = run('guard.mjs',
    { tool_name: 'Read', session_id: 'g2', cwd: projB, tool_input: { file_path: big } }, dir);
  assert.match(stillWorks, /governor-guard/, 'project B, untouched, still gets advised');
});

test('guard stays SILENT on already-bounded calls (false positives get it uninstalled)', () => {
  const dir = sandbox();
  const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-big-')), 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(300_000));

  assert.equal(run('guard.mjs', { tool_name: 'Read', session_id: 'a', tool_input: { file_path: big, limit: 100 } }, dir).trim(), '');
  assert.equal(run('guard.mjs', { tool_name: 'Grep', session_id: 'b', tool_input: { pattern: 'x', output_mode: 'content', head_limit: 20 } }, dir).trim(), '');
  assert.equal(run('guard.mjs', { tool_name: 'Grep', session_id: 'c', tool_input: { pattern: 'x' } }, dir).trim(), '', 'files_with_matches is already small');
  assert.equal(run('guard.mjs', { tool_name: 'Bash', session_id: 'd', tool_input: { command: 'npm test 2>&1 | tail -40' } }, dir).trim(), '');
  assert.equal(run('guard.mjs', { tool_name: 'Bash', session_id: 'e', tool_input: { command: 'git status' } }, dir).trim(), '');
  assert.equal(run('guard.mjs', { tool_name: 'Read', session_id: 'f', tool_input: { file_path: '/does/not/exist' } }, dir).trim(), '', 'cannot prove anything about a missing file');
});

test('guard advises on an unbounded build command', () => {
  const dir = sandbox();
  const out = run('guard.mjs', { tool_name: 'Bash', session_id: 'z', tool_input: { command: 'npm run build' } }, dir);
  assert.match(out, /governor-guard/);
});

test('guard is rate-limited per session', () => {
  const dir = sandbox();
  const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-big-')), 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(300_000));
  let fired = 0;
  for (let i = 0; i < 12; i++) {
    if (run('guard.mjs', { tool_name: 'Read', session_id: 'rl', tool_input: { file_path: big } }, dir).trim()) fired++;
  }
  assert.ok(fired <= 6, `expected <=6 advisories, got ${fired}`);
});

/* ------------------------------------------------------------------- safety */

test('hooks never crash the session on hostile input', () => {
  const dir = sandbox();
  for (const s of ['statusline.mjs', 'limit-guard.mjs', 'session-start.mjs', 'guard.mjs']) {
    assert.doesNotThrow(() => run(s, {}, dir), `${s} on empty payload`);
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [path.join(RT, s)], {
        input: 'not json at all',
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      });
    }, `${s} on malformed stdin`);
  }
});

test('statusline is fast enough to run 1×/second', () => {
  const dir = sandbox();
  const payload = {
    session_id: 'p', model: { id: 'claude-opus-5' },
    context_window: { total_input_tokens: 250_000, used_percentage: 25, context_window_size: 1_000_000 },
    rate_limits: { five_hour: { used_percentage: 55, resets_at: 2_000_000_000 } },
  };
  const times = [];
  for (let i = 0; i < 25; i++) {
    const t0 = process.hrtime.bigint();
    run('statusline.mjs', payload, dir);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  // Includes full node process startup, which the real hook also pays.
  assert.ok(p95 < 250, `statusline p95 ${p95.toFixed(0)}ms too slow for a 1s refresh`);
});

test('statusline never parses the transcript (which would be self-defeating at 1×/sec)', () => {
  const src = fs.readFileSync(path.join(RT, 'statusline.mjs'), 'utf8');
  assert.ok(!/readRecords|analyzeSession|createReadStream/.test(src),
    'must rely on the payload, not re-read a 24MB transcript every second');
});

test('render suppresses info the wrapped statusline already shows — but never the warning', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'governor', 'config.json'), JSON.stringify({
    // Their line already prints Ctx and 5h, wrapped in ANSI codes.
    wrappedStatusLine: `printf '\\033[90mCtx\\033[0m 19%% | \\033[90m5h\\033[0m 61%%'`,
  }));
  const payload = (used) => ({
    session_id: 'x', model: { id: 'claude-opus-5' },
    context_window: { total_input_tokens: 187_000, used_percentage: 19, context_window_size: 1_000_000 },
    rate_limits: { five_hour: { used_percentage: used, resets_at: 2_000_000_000 } },
  });

  const quiet = run('statusline.mjs', payload(61), dir);
  assert.ok(!/ctx 187k/.test(quiet), 'duplicate ctx suppressed (ANSI must not defeat matching)');
  assert.ok(!/5h 61%/.test(quiet), 'duplicate 5h suppressed');
  assert.match(quiet, /cmp~/, 'additive info still shown');

  const loud = run('statusline.mjs', payload(88), dir);
  assert.match(loud, /handoff/, 'the warning is never suppressed');
});

test('statusline shows "Governor ON" only when actually enabled — not decorative', () => {
  const dir = sandbox();
  const payload = { session_id: 'x', model: { id: 'claude-sonnet-5' } };

  const on = run('statusline.mjs', payload, dir);
  assert.match(on, /Governor ON/);

  fs.writeFileSync(path.join(dir, 'governor', 'config.json'), JSON.stringify({ enabled: false }));
  const off = run('statusline.mjs', payload, dir);
  assert.match(off, /Governor OFF/);
  assert.doesNotMatch(off, /Governor ON/);
});

test('OFF preserves the wrapped statusline exactly — nothing stripped, nothing added but the label', () => {
  const dir = sandbox();
  const bar = `printf '\\033[31m[BAR####]\\033[0m mymodel'`;
  fs.writeFileSync(path.join(dir, 'governor', 'config.json'),
    JSON.stringify({ enabled: false, wrappedStatusLine: bar }));

  const out = run('statusline.mjs', { session_id: 'x' }, dir);
  assert.match(out, /\[BAR####\]/, 'the wrapped bar survives untouched');
  assert.match(out, /mymodel/);
  assert.match(out, /Governor OFF/);
  assert.doesNotMatch(out, /ctx |5h /, 'no Governor metrics injected while off');
});

test('governor on / off toggles cfg.enabled for real, not just a message', async () => {
  const dir = sandbox();
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { loadConfig, saveConfig } = await import(`../src/core/state.mjs?v=${Math.random()}`);
  saveConfig({ enabled: true });

  execFileSync(process.execPath, [path.join(HERE, '..', 'src', 'cli', 'governor.mjs'), 'off'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
  });
  assert.equal(loadConfig().enabled, false);

  execFileSync(process.execPath, [path.join(HERE, '..', 'src', 'cli', 'governor.mjs'), 'on'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
  });
  assert.equal(loadConfig().enabled, true);
});

test('Governor line is inserted right after the wrapped line — as its own line, not appended inline', () => {
  const dir = sandbox();
  // A wrapped script whose own output is already a single, full line — like a real
  // dir/model/ctx bar-based statusline. Governor must not tack text onto its end.
  fs.writeFileSync(path.join(dir, 'governor', 'config.json'), JSON.stringify({
    wrappedStatusLine: `printf 'Dir ~/proj | Model Sonnet 5'`,
  }));
  const out = run('statusline.mjs', { session_id: 'x', model: { id: 'claude-sonnet-5' } }, dir);
  const lines = out.split('\n');
  assert.equal(lines.length, 2, 'exactly two lines: theirs, then ours');
  assert.match(lines[0], /Dir ~\/proj \| Model Sonnet 5/, 'their line is untouched, first');
  assert.match(lines[1], /Governor ON/, 'our line is second, separate');
});

test('the 7-day ("week") window renders alongside the 5-hour one when the payload has it', () => {
  const dir = sandbox();
  const payload = {
    session_id: 'x',
    model: { id: 'claude-sonnet-5' },
    rate_limits: {
      five_hour: { used_percentage: 40, resets_at: 2_000_000_000 },
      seven_day: { used_percentage: 70, resets_at: 2_000_100_000 },
    },
  };
  const out = run('statusline.mjs', payload, dir);
  assert.match(out, /5h 40%/);
  assert.match(out, /week 70%/);
});

/* ------------------------------------------------- integration contract */

/**
 * Verified hook events, read from the Claude Code binary's hookSpecificOutput schema.
 * Registering under a name outside this list means the hook NEVER FIRES — silently.
 * This exact bug shipped once: `PostToolUseBatch` does not exist; the real name is
 * `PostToolBatch`. Logic tests could not catch it because they piped stdin directly.
 */
const VALID_HOOK_EVENTS = new Set([
  'CwdChanged', 'Elicitation', 'ElicitationResult', 'FileChanged', 'MessageDisplay',
  'Notification', 'PermissionDenied', 'PermissionRequest', 'PostToolBatch', 'PostToolUse',
  'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Setup', 'Stop', 'SubagentStart',
  'SubagentStop', 'UserPromptExpansion', 'UserPromptSubmit', 'WorktreeCreate',
]);

test('CONTRACT — every hookEventName we emit is a real Claude Code event', () => {
  const dir = sandbox();
  const cases = [
    ['limit-guard.mjs', { rate: 92 }],
    ['session-start.mjs', { handoff: true }],
    ['guard.mjs', { big: true }],
  ];

  // limit-guard needs the sensor primed for the SAME session_id it will be called with.
  const sid = 'contract-1';
  run('statusline.mjs', { session_id: sid, rate_limits: { five_hour: { used_percentage: 92, resets_at: 4242 } } }, dir);
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-c-'));
  fs.writeFileSync(path.join(proj, 'HANDOFF.md'), '# H\n## NEXT\ngo\n');
  const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-c2-')), 'b.txt');
  fs.writeFileSync(big, 'x'.repeat(300_000));

  const outputs = [
    run('limit-guard.mjs', { cwd: proj, session_id: sid }, dir),
    run('session-start.mjs', { source: 'startup', cwd: proj }, dir),
    run('guard.mjs', { tool_name: 'Read', session_id: 'c', tool_input: { file_path: big } }, dir),
  ];

  let checked = 0;
  for (const out of outputs) {
    if (!out.trim()) continue;
    const name = JSON.parse(out).hookSpecificOutput?.hookEventName;
    assert.ok(VALID_HOOK_EVENTS.has(name), `"${name}" is not a real Claude Code hook event`);
    checked++;
  }
  assert.equal(checked, 3, 'all three hooks emitted output to check');
});

test('CONTRACT — every event we register in settings is a real event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-reg-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { install } = await import(`../src/core/install.mjs?v=${Math.random()}`);
  install({});
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  for (const ev of Object.keys(s.hooks || {})) {
    assert.ok(VALID_HOOK_EVENTS.has(ev), `registered under "${ev}", which does not exist`);
  }
  assert.ok(Object.keys(s.hooks).length >= 3);
});
