import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Install safety. Modelled on a REAL user config: three pre-existing hook events and a
 * custom bash statusline. Destroying those is the fastest way to get uninstalled.
 */

// A config that mirrors the machine this was built on.
const EXISTING = {
  model: 'opus',
  effortLevel: 'medium',
  statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh', refreshInterval: 1 },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '"/Users/x/.claude/hooks/third-party-a.mjs"' }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/Users/x/.claude/hooks/third-party-b.mjs"' }] }],
    SubagentStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/Users/x/.claude/hooks/third-party-c.mjs"' }] }],
  },
  enabledPlugins: { 'some-plugin': true },
};

function sandbox(settings = EXISTING) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-inst-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}

/**
 * Mirrors install.mjs's own isOurs(): match the absolute runtime path first (works
 * regardless of what the checkout directory happens to be named), fall back to the
 * case-insensitive brand name for a command written by some other install location.
 */
const RUNTIME_DIR = path.join(process.cwd(), 'src', 'runtime');
const ours = (c) => {
  const s = String(c || '');
  return s.includes(RUNTIME_DIR) || s.toLowerCase().includes('governor');
};

const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

/** install.mjs resolves paths at call time, so re-import per sandbox. */
async function freshInstall(dir) {
  process.env.CLAUDE_CONFIG_DIR = dir;
  const mod = await import(`../src/core/install.mjs?v=${Math.random()}`);
  return mod;
}

const countHooks = (s) =>
  Object.values(s.hooks || {}).flat().flatMap((e) => e.hooks || []).length;

test('install PRESERVES pre-existing hooks and wraps the existing statusline', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  const res = install({});

  const s = readSettings(dir);
  const cmds = Object.values(s.hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));

  assert.ok(cmds.some((c) => c.includes('third-party-a')), 'existing SessionStart hook survived');
  assert.ok(cmds.some((c) => c.includes('third-party-b')), 'existing PostToolUse hook survived');
  assert.ok(cmds.some((c) => c.includes('third-party-c')), 'existing SubagentStart hook survived');

  assert.ok(ours(s.statusLine.command), 'our statusline is active');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'governor', 'config.json'), 'utf8'));
  assert.equal(cfg.wrappedStatusLine, 'bash ~/.claude/statusline-command.sh', 'previous statusline preserved for restore');

  assert.equal(s.enabledPlugins['some-plugin'], true, 'unrelated settings untouched');
  assert.equal(res.decision.value, 250_000, 'opus alias -> 25% of 1M');
  assert.equal(s.autoCompactWindow, 250_000);
});

test('install is IDEMPOTENT — no duplicate hook entries', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);

  install({});
  const first = readSettings(dir);
  const n1 = countHooks(first);

  install({});
  const second = readSettings(dir);
  assert.equal(countHooks(second), n1, 'second install adds nothing');
  assert.deepEqual(second.hooks, first.hooks);

  const mine = Object.values(second.hooks).flat()
    .flatMap((e) => e.hooks).filter((h) => ours(h.command));
  assert.equal(mine.length, 3, 'exactly our three hooks, once each');
});

test('install does not re-wrap its own statusline on reinstall', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  install({});
  install({});
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'governor', 'config.json'), 'utf8'));
  assert.equal(cfg.wrappedStatusLine, 'bash ~/.claude/statusline-command.sh',
    'must not capture our own command as the "previous" one');
});

test('read-back assert confirms the window actually persisted', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  const res = install({});
  assert.equal(readSettings(dir).autoCompactWindow, res.decision.value);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath), 'a backup was taken before writing');
});

test('uninstall restores the original statusline and removes only our hooks', async () => {
  const dir = sandbox();
  const { install, uninstall } = await freshInstall(dir);
  install({});
  uninstall();

  const s = readSettings(dir);
  assert.equal(s.statusLine.command, 'bash ~/.claude/statusline-command.sh', 'original restored');

  const cmds = Object.values(s.hooks || {}).flat().flatMap((e) => e.hooks.map((h) => h.command));
  assert.equal(cmds.filter(ours).length, 0, 'ours removed');
  assert.ok(cmds.some((c) => c.includes('third-party-a')), 'theirs kept');
  assert.ok(cmds.some((c) => c.includes('third-party-b')), 'theirs kept');
  assert.ok(cmds.some((c) => c.includes('third-party-c')), 'theirs kept');
  assert.equal(s.autoCompactWindow, undefined, 'window setting removed');
});

test('install works on a clean machine with no settings.json at all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-clean-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { install } = await import(`../src/core/install.mjs?v=${Math.random()}`);
  const res = install({});
  const s = readSettings(dir);
  assert.equal(s.autoCompactWindow, res.decision.value);
  assert.ok(ours(s.statusLine.command));
});

test('BUG REGRESSION — reinstalling after an uninstall comes back ON, not silently stuck OFF', async () => {
  const dir = sandbox();
  const { install, uninstall } = await freshInstall(dir);
  install({});
  uninstall(); // persists enabled:false to record the stopped state

  install({}); // a fresh install is an unambiguous request to be on again
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'governor', 'config.json'), 'utf8'));
  assert.equal(cfg.enabled, true, 'install must not inherit a stale disabled flag from a prior uninstall');
});

test('a true-vanilla machine (no statusLine at all) gets a real default template, not nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-vanilla-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { install } = await import(`../src/core/install.mjs?v=${Math.random()}`);
  install({});

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'governor', 'config.json'), 'utf8'));
  assert.match(cfg.wrappedStatusLine, /default-statusline\.sh/, 'wraps our own shipped default');

  const scriptPath = path.join(dir, 'governor', 'default-statusline.sh');
  assert.ok(fs.existsSync(scriptPath), 'the template was actually copied, not just referenced');
  const script = fs.readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(script, /Cache/, 'cache segment excluded from the default template');
  assert.doesNotMatch(script, /7d/, '7-day segment excluded from the default template');
  assert.match(script, /Dir\$\{RESET\}/, 'dir segment present');
  assert.match(script, /Model\$\{RESET\}/, 'model segment present');
});

test('uninstall after a true-vanilla install returns to real vanilla, not a leftover pointer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-vanilla2-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { install, uninstall } = await import(`../src/core/install.mjs?v=${Math.random()}`);
  install({});
  uninstall();

  const s = readSettings(dir);
  assert.equal(s.statusLine, undefined, 'no statusLine key left behind at all');
  assert.ok(!fs.existsSync(path.join(dir, 'governor', 'default-statusline.sh')), 'template file cleaned up');
});

test('agents and skills are written and carry pinned model + effort', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  install({});

  const scout = fs.readFileSync(path.join(dir, 'agents', 'gv-scout.md'), 'utf8');
  assert.match(scout, /^model: haiku$/m, 'cheap model pinned, not inherited');
  assert.match(scout, /^effort: low$/m, 'effort pinned too');
  assert.match(scout, /^maxTurns: \d+$/m, 'kill condition present');

  const arch = fs.readFileSync(path.join(dir, 'agents', 'gv-architect.md'), 'utf8');
  assert.match(arch, /^model: opus$/m);
  assert.match(arch, /^effort: high$/m);

  assert.ok(fs.existsSync(path.join(dir, 'skills', 'gv-handoff', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'gv-delegate', 'SKILL.md')));
});

test('an existing non-Governor agent of the same name is NOT clobbered', async () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const mine = path.join(dir, 'agents', 'gv-scout.md');
  fs.writeFileSync(mine, '---\nname: my-own-scout\n---\nhand written\n');

  const { install } = await freshInstall(dir);
  const res = install({});
  assert.equal(fs.readFileSync(mine, 'utf8'), '---\nname: my-own-scout\n---\nhand written\n');
  assert.ok(res.artifacts.some((a) => a.skipped === 'name collision'), 'and it says so');
});

test('refuses to write a value Claude Code would silently discard', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  // A policy that resolves below the 100k floor must clamp, never write junk.
  fs.mkdirSync(path.join(dir, 'governor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'governor', 'config.json'),
    JSON.stringify({ window: { opus: 0.01, sonnet: 0.01, haiku: 0.01 } }));
  const res = install({});
  assert.ok(res.decision.value >= 100_000, 'clamped into the accepted range');
  assert.ok(res.warnings.length > 0, 'and warned about it');
  assert.equal(readSettings(dir).autoCompactWindow, res.decision.value);
});

test('install writes the Plan Mode execution rule to global CLAUDE.md', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  install({});
  const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Execution Plan/);
  assert.match(claudeMd, /governor:planmode:start/);
});

test('install appends the Plan Mode rule to an existing CLAUDE.md without disturbing it', async () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# House rules\n\nAlways use tabs.\n');
  const { install } = await freshInstall(dir);
  install({});
  const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Always use tabs\./, 'existing rules preserved');
  assert.match(claudeMd, /governor:planmode:start/);
});

test('uninstall removes the Plan Mode rule but keeps the rest of CLAUDE.md', async () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# House rules\n\nAlways use tabs.\n');
  const { install, uninstall } = await freshInstall(dir);
  install({});
  uninstall();
  const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Always use tabs\./);
  assert.doesNotMatch(claudeMd, /governor:planmode/);
});

test('install writes the mistake-log rule to global CLAUDE.md, alongside the Plan Mode rule', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  install({});
  const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /MISTAKES\.md/);
  assert.match(claudeMd, /governor:mistakes:start/);
  assert.match(claudeMd, /governor:planmode:start/, 'both blocks coexist');
});

test('uninstall removes the mistake-log rule but keeps the rest of CLAUDE.md', async () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# House rules\n\nAlways use tabs.\n');
  const { install, uninstall } = await freshInstall(dir);
  install({});
  uninstall();
  const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Always use tabs\./);
  assert.doesNotMatch(claudeMd, /governor:mistakes/);
});

test('gv-mistakes skill is written and explains check-first, log-selectively', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  install({});
  const s = fs.readFileSync(path.join(dir, 'skills', 'gv-mistakes', 'SKILL.md'), 'utf8');
  assert.match(s, /Check first/);
  assert.match(s, /MISTAKES\.md/);
  assert.match(s, /Symptom/);
  assert.match(s, /Do not/);
});

test('gv-bugplan defaults to fixing directly — the plan is escalation, not the entry point', async () => {
  const dir = sandbox();
  const { install } = await freshInstall(dir);
  install({});
  const s = fs.readFileSync(path.join(dir, 'skills', 'gv-bugplan', 'SKILL.md'), 'utf8');

  assert.match(s, /Just fix it/, 'cheap bugs bypass planning entirely');
  assert.match(s, /governor impact/, 'gate uses the mechanical blast radius, not file reading');
  assert.match(s, /One plan for the group/, 'batches related bugs');
  assert.match(s, /NEW bug/, 'still asks what a fix could break');
  assert.match(s, /Plan a one-line fix/, 'has an explicit do-not list');
});
