#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { findTranscripts, projectsDir, configDir, settingsPath } from '../core/paths.mjs';
import { analyzeAll, retentionOffenders } from '../core/analyze.mjs';
import { rates, fmtUSD, fmtTok } from '../core/price.mjs';
import { computeWindow, envOverride, DEFAULT_PCT } from '../core/policy.mjs';
import { simulateAll, actualTotal, OBSERVED_TRIGGER_FRACTION } from '../core/sim.mjs';
import { install, uninstall, probe } from '../core/install.mjs';
import { loadConfig, saveConfig, countLimitStates, listLimitStates } from '../core/state.mjs';
import { spawnSync } from 'node:child_process';
import { refresh, saveIndex } from '../routes/refresh.mjs';
import { saveBaseline, loadBaseline, compare } from '../core/proof.mjs';
import { loadIndex } from '../routes/refresh.mjs';
import { impactOf } from '../routes/impact.mjs';
import { selfCost } from '../core/selfcost.mjs';
import {
  upsertBlock, removeBlock, hasBlock,
  PLAN_MODE_ID, PLAN_MODE_BLOCK, MISTAKES_ID, MISTAKES_BLOCK, ROUTING_ID, ROUTING_BLOCK,
} from '../core/claudemd.mjs';

const claudeMdPath = () => path.join(configDir(), 'CLAUDE.md');
const CLAUDE_MD_BLOCKS = [
  [PLAN_MODE_ID, PLAN_MODE_BLOCK],
  [MISTAKES_ID, MISTAKES_BLOCK],
  [ROUTING_ID, ROUTING_BLOCK],
];

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m', G = '\x1b[32m', Y = '\x1b[33m', RD = '\x1b[31m';

function bar(frac, width = 22) {
  const f = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '█'.repeat(f) + '·'.repeat(width - f);
}
function head(t) { console.log(`\n  ${B}${t}${R}\n  ${'─'.repeat(56)}`); }

async function loadCorpus() {
  const files = findTranscripts();
  if (!files.length) {
    console.error(`No transcripts under ${projectsDir()}`);
    console.error(`(config dir ${configDir()} — set CLAUDE_CONFIG_DIR if yours differs)`);
    process.exit(1);
  }
  process.stderr.write(`Scanning ${files.length} transcripts…\r`);
  const res = await analyzeAll(files);
  process.stderr.write(`${' '.repeat(46)}\r`);
  return res;
}

/* -------------------------------------------------------------------- report */

async function cmdReport() {
  const { agg, sessions, ranked } = await loadCorpus();
  const r = rates('sonnet');
  const comp = [
    ['cache READ', agg.cacheRead, r.cacheRead],
    ['cache WRITE (1h)', agg.write1h, r.cacheWrite1h],
    ['cache WRITE (5m)', agg.write5m + agg.unsplitWrite, r.cacheWrite5m],
    ['output', agg.output, r.output],
    ['uncached input', agg.input, r.input],
  ].map(([label, tok, rate]) => ({ label, tok, cost: (tok / 1e6) * rate }));
  const total = comp.reduce((n, c) => n + c.cost, 0);
  comp.sort((a, b) => b.cost - a.cost);

  console.log(`\n  ${B}Governor — where your tokens went${R}`);
  console.log(`  ${agg.requests.toLocaleString('en-US')} requests · ${agg.sessions} sessions`);

  head('BILL');
  console.log(`  ${pad('COMPONENT', 18)}${lpad('TOKENS', 16)}${lpad('~COST', 11)}${lpad('%', 7)}`);
  for (const c of comp) {
    console.log(`  ${pad(c.label, 18)}${lpad(fmtTok(c.tok), 16)}${lpad(fmtUSD(c.cost), 11)}${lpad(pct(total ? c.cost / total : 0), 7)}`);
  }
  console.log(`  ${pad('TOTAL', 18)}${lpad('', 16)}${lpad(fmtUSD(total), 11)}`);
  console.log(`  ${D}$ = estimate from a local pricing table, not billing data.${R}`);

  head('STRUCTURE');
  console.log(`  cache hit rate   ${bar(agg.cacheHitRate)} ${pct(agg.cacheHitRate)}`);
  console.log(`  subagent share   ${bar(agg.subagentShare)} ${pct(agg.subagentShare)}  ${D}(${agg.subagentRequests.toLocaleString('en-US')} reqs)${R}`);
  console.log(`  top 5 sessions   ${bar(agg.top5Share)} ${pct(agg.top5Share)} of all input`);
  console.log(`  compactions      ${agg.compactions} across ${agg.sessions} sessions`);

  const t = agg.tool;
  head('RETRIEVAL CONCENTRATION');
  console.log(`  ${fmtTok(t.count)} tool results · ${fmtTok(t.tokens)} tokens`);
  console.log(`  >5k tokens:  ${fmtTok(t.bigCount)} results (${pct(t.bigCountShare)} of count) = ${B}${pct(t.bigTokenShare)}${R} of tool tokens`);
  console.log(`  largest:     ${fmtTok(t.largest)} tokens in a single result`);

  const off = retentionOffenders(sessions, 5);
  if (off.length) {
    head('MOST EXPENSIVE ADMISSIONS  (size × turns retained)');
    for (const o of off) {
      console.log(`  ${RD}${lpad(fmtUSD(o.cost), 9)}${R}  ${pad(o.tool.slice(0, 30), 32)} ${fmtTok(o.tokens)} tok`);
      console.log(`  ${D}          turn ${o.admittedAtTurn}/${o.totalTurns} → re-read ~${fmtTok(o.turnsRemaining)}×${R}`);
    }
  }

  head('HEAVIEST SESSIONS');
  for (const s of ranked.slice(0, 5)) {
    const per = s.requests ? Math.round(s.totalInput / s.requests) : 0;
    const flag = s.compactions === 0 && per > 150_000 ? `${RD}no compaction${R}` : `${s.compactions} compacts`;
    console.log(`  ${lpad(fmtTok(s.totalInput), 14)}  ${lpad(s.requests, 5)} reqs  ${lpad(fmtTok(per), 9)}/req  ${flag}  ${D}${s.project.slice(0, 26)}${R}`);
  }
  console.log(`\n  ${D}Next: ${B}governor tune${R}${D} to size your compaction window.${R}\n`);
}

/* ---------------------------------------------------------------------- tune */

async function cmdTune() {
  const { sessions } = await loadCorpus();
  const actual = actualTotal(sessions);
  const cfg = loadConfig();
  const model = process.argv[3] || 'claude-sonnet-5';
  const d = computeWindow(model, { pct: cfg.window });

  console.log(`\n  ${B}Governor — window tuning${R}`);
  console.log(`  model ${model} · context window ${d.modelWindow.toLocaleString('en-US')}`);
  console.log(`  ${D}Compaction fires near ${Math.round(OBSERVED_TRIGGER_FRACTION * 100)}% of the configured window`);
  console.log(`  (calibrated from a real compaction in your own transcripts).${R}`);

  head('MEASURED AGAINST YOUR OWN SESSIONS');
  console.log(`  ${pad('WINDOW', 12)}${pad('TRIGGERS ~AT', 15)}${lpad('INPUT TOKENS', 16)}${lpad('SAVING', 9)}${lpad('COMPACTS', 10)}`);
  const fractions = [0.10, 0.15, 0.20, 0.25, 0.35, 0.50, 0.75, 1.0];
  for (const f of fractions) {
    const w = Math.round(d.modelWindow * f);
    if (w < 100_000 || w > 1_000_000) continue;
    const sim = simulateAll(sessions, w);
    const saving = actual > 0 ? (actual - sim.total) / actual : 0;
    const mark = Math.abs(f - d.fraction) < 0.001 ? `${G} ← your policy${R}` : '';
    const thrash = sim.thrashySessions > 0 ? ` ${Y}${sim.thrashySessions} thrashy${R}` : '';
    console.log(
      `  ${pad(fmtTok(w), 12)}${pad(fmtTok(Math.round(w * OBSERVED_TRIGGER_FRACTION)), 15)}` +
      `${lpad(fmtTok(sim.total), 16)}${lpad(pct(saving), 9)}${lpad(sim.compactions, 10)}${thrash}${mark}`
    );
  }
  console.log(`\n  ${D}Actual today: ${fmtTok(actual)} input tokens.`);
  console.log(`  Lower is cheaper but compacts more often; thrash costs turns, not just tokens.${R}`);
  console.log(`\n  Current policy: sonnet ${pct(cfg.window.sonnet)} · opus ${pct(cfg.window.opus)}`);
  console.log(`  ${D}Edit ${path.join(configDir(), 'governor', 'config.json')} to change.${R}\n`);
}

/* -------------------------------------------------------------------- gate 0 */

async function cmdGate0() {
  const files = findTranscripts();
  console.log(`\n  ${B}Gate 0 — does compaction actually fire, and where?${R}`);
  head('OBSERVED COMPACTIONS IN YOUR TRANSCRIPTS');

  const { readRecords, usageOf, contextTokens, isCompactBoundary } = await import('../core/parse.mjs');
  let found = 0;
  for (const f of files) {
    const trail = [];
    const hits = [];
    for await (const rec of readRecords(f)) {
      if (isCompactBoundary(rec)) hits.push(trail.length);
      const u = usageOf(rec);
      if (u) trail.push(contextTokens(u));
    }
    for (const h of hits) {
      const before = trail.slice(Math.max(0, h - 1), h);
      const after = trail.slice(h, h + 1);
      if (!before.length || !after.length) continue;
      found++;
      const drop = 1 - after[0] / before[0];
      console.log(`  ${path.basename(f).slice(0, 8)}  before ${lpad(fmtTok(before[0]), 8)} → after ${lpad(fmtTok(after[0]), 8)}  ${G}−${pct(drop)}${R}`);
    }
  }
  if (!found) {
    console.log(`  ${Y}No compaction observed in any session.${R}`);
    console.log(`  ${D}That is itself the finding: the default window is high enough that`);
    console.log(`  compaction effectively never fires. Lower it with: governor install${R}`);
  } else {
    console.log(`\n  ${found} compaction(s) observed. Compaction works and resets context hard.`);
    console.log(`  ${D}The trigger scales with autoCompactWindow, so lowering the setting`);
    console.log(`  lowers where this happens.${R}`);
  }
  console.log();
}

/* ------------------------------------------------------------------- install */

function printProbe(results) {
  for (const r of results) {
    const icon = r.ok ? `${G}✔${R}` : `${Y}!${R}`;
    console.log(`  ${icon} ${pad(r.name, 34)} ${D}${r.detail}${R}`);
  }
}

async function cmdInstall(dryRun) {
  console.log(`\n  ${B}Governor — ${dryRun ? 'dry run' : 'training your Claude Code'}${R}`);
  head('CAPABILITY PROBE');
  const p = probe();
  printProbe(p.results);

  const res = install({ dryRun });
  head(dryRun ? 'WOULD APPLY' : 'APPLIED');
  for (const n of res.notes) console.log(`  ${G}·${R} ${n}`);
  for (const w of res.warnings) console.log(`  ${Y}! ${w}${R}`);

  if (dryRun) {
    console.log(`\n  ${D}Nothing was written. Run without --dry-run to apply.${R}\n`);
    return;
  }
  console.log(`  ${G}·${R} ${res.artifacts.filter((a) => !a.skipped).length} agents/skills written`);
  for (const a of res.artifacts.filter((x) => x.skipped)) {
    console.log(`  ${Y}! skipped ${a.path} (${a.skipped})${R}`);
  }
  if (res.backupPath) console.log(`  ${G}·${R} settings backed up to ${res.backupPath}`);
  console.log(`  ${G}·${R} read-back assert passed — the value persisted`);
  console.log(`\n  ${B}Restart Claude Code for settings to take effect.${R}`);
  console.log(`  ${D}Undo at any time: governor untrain${R}\n`);
}

async function cmdUninstall() {
  const r = uninstall();
  console.log(`\n  ${G}Governor removed.${R}`);
  if (r.restoredStatusLine) console.log(`  statusLine restored: ${r.restoredStatusLine}`);
  if (r.backupPath) console.log(`  ${D}backup: ${r.backupPath}${R}`);
  console.log(`  ${D}Restart Claude Code.${R}\n`);
}

/* -------------------------------------------------------------------- verify */

/**
 * Plain-language proof that setup actually worked — for a non-technical user who will
 * never read a stack trace. Written for the intended real audience: this product is
 * meant to be handed to founders/CEOs as a lead magnet, most of whom have never opened
 * a terminal. Claude runs this on their behalf and translates the result into normal
 * words; it must never require the user to interpret JSON or an error code themselves.
 */
async function cmdVerify() {
  console.log(`\n  ${B}Governor — is this actually working?${R}\n`);

  let s = {};
  let settingsReadable = true;
  try { s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { settingsReadable = false; }

  const nodeOk = spawnSync(process.execPath, ['--version'], { timeout: 3000 }).status === 0;
  const slConfigured = String(s.statusLine?.command || '').toLowerCase().includes('governor');
  const events = Object.keys(s.hooks || {});
  const hooksConfigured = ['PreToolUse', 'PostToolBatch', 'SessionStart'].every((e) => events.includes(e));
  const planModeConfigured = hasBlock(path.join(configDir(), 'CLAUDE.md'), PLAN_MODE_ID);

  const states = listLimitStates();
  const fresh = states.filter((st) => st.ageMs < 2 * 60_000); // touched in the last 2 minutes
  const anyEverSeen = states.length > 0;
  const anyAvailable = fresh.some((st) => st.available);

  const ok = (b) => (b ? `${G}yes${R}` : `${RD}no${R}`);
  console.log(`  Node.js works:              ${ok(nodeOk)}`);
  console.log(`  Settings file readable:     ${ok(settingsReadable)}`);
  console.log(`  Status line turned on:      ${ok(slConfigured)}`);
  console.log(`  Alerts turned on:           ${ok(hooksConfigured)}`);
  console.log(`  Plan Mode gives full steps: ${ok(planModeConfigured)}`);
  console.log();

  if (!nodeOk) {
    console.log(`  ${RD}Node.js isn't working on this computer.${R} That has to be fixed before anything`);
    console.log(`  else here can run. On a Mac, the easiest way is to install it from nodejs.org`);
    console.log(`  (the "LTS" version), then try again.`);
  } else if (!settingsReadable || !slConfigured || !hooksConfigured || !planModeConfigured) {
    console.log(`  ${Y}Setup did not fully apply.${R} Run the installer again:`);
    console.log(`  ${B}node src/cli/governor.mjs install${R}`);
  } else if (anyAvailable) {
    console.log(`  ${G}It's working.${R} Governor is receiving real usage data right now.`);
  } else if (anyEverSeen) {
    console.log(`  ${Y}Set up correctly, but no fresh data yet.${R} This is normal for the first`);
    console.log(`  minute after installing. Send one message in this chat, wait a few seconds,`);
    console.log(`  and check again.`);
  } else {
    console.log(`  ${Y}Set up correctly, but nothing has been seen yet.${R} This is expected if`);
    console.log(`  Claude Code has not been restarted since installing — settings only take`);
    console.log(`  effect on the NEXT restart. Restart Claude Code, send a message, then run`);
    console.log(`  this again.`);
  }
  console.log();
  return { nodeOk, settingsReadable, slConfigured, hooksConfigured, planModeConfigured, anyAvailable, anyEverSeen };
}

/* -------------------------------------------------------------------- doctor */

async function cmdDoctor() {
  console.log(`\n  ${B}Governor — doctor${R}`);
  head('PROBE');
  printProbe(probe().results);

  head('CURRENT SETTINGS');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { /* ignore */ }
  const model = s.model || 'claude-sonnet-5';
  const d = computeWindow(model, { pct: loadConfig().window });
  console.log(`  model                ${model}`);
  console.log(`  autoCompactWindow    ${s.autoCompactWindow ? s.autoCompactWindow.toLocaleString('en-US') : `${Y}(auto — compaction rarely fires)${R}`}`);
  console.log(`  policy target        ${d.value.toLocaleString('en-US')} ${D}(${Math.round(d.fraction * 100)}% of ${d.modelWindow.toLocaleString('en-US')})${R}`);
  console.log(`  triggers near        ~${Math.round((s.autoCompactWindow || d.modelWindow) * OBSERVED_TRIGGER_FRACTION).toLocaleString('en-US')} tokens`);
  const env = envOverride();
  if (env) console.log(`  ${Y}! ${env.message}${R}`);
  const planModeConfigured = hasBlock(path.join(configDir(), 'CLAUDE.md'), PLAN_MODE_ID);
  console.log(`  Plan Mode execution rule ${planModeConfigured ? `${G}installed${R}` : `${RD}not installed${R}`} ${D}(global CLAUDE.md)${R}`);

  head('5-HOUR SENSOR');
  // Each Claude Code window tracks its OWN reading (see state.mjs) — a CLI command run
  // outside any of them has no way to know which one you mean. Point at the real source
  // of truth (that window's statusline, or /usage) instead of guessing.
  const n = countLimitStates();
  console.log(`  ${D}This can't be checked from the CLI — a session's rate-limit reading lives with`);
  console.log(`  that session's own window, and this command isn't running inside one.${R}`);
  console.log(`  ${D}Run ${R}/usage${D} in the Claude Code window you care about, or look at its statusline.${R}`);
  if (n > 0) console.log(`  ${D}(${n} session(s) currently tracked on this machine)${R}`);
  console.log();
}

/* -------------------------------------------------------------------- routes */

async function cmdRoutes() {
  const root = path.resolve(process.argv[3] || process.cwd());
  console.log(`\n  ${B}Governor — route map${R}\n  ${D}${root}${R}`);
  const { index, delta, tiered, files } = refresh(root);
  for (const f of files) {
    const dest = path.join(root, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content);
  }
  saveIndex(root, index);

  head('RESULT');
  const rootBytes = Buffer.byteLength(files[0].content);
  console.log(`  ${index.entries.length} files indexed → ${path.join(root, 'ROUTES.md')}`);
  console.log(`  root map ${fmtTok(Math.round(rootBytes / 4))} tokens${tiered ? ` ${Y}(two-tier: detail in ${files.length - 1} per-directory files)${R}` : ''}`);
  console.log(`  ${D}generated mechanically — no model was used, so this cost ~0 tokens${R}`);
  if (delta.added.length || delta.changed.length || delta.removed.length) {
    console.log(`  ${G}+${delta.added.length}${R} added · ${Y}~${delta.changed.length}${R} changed · ${RD}-${delta.removed.length}${R} removed`);
    for (const p of delta.removed.slice(0, 5)) console.log(`  ${RD}  gone: ${p}${R} ${D}(stale pointer removed)${R}`);
  }
  console.log(`\n  ${D}Tell Claude to read ROUTES.md before searching the codebase.${R}\n`);
}

/* --------------------------------------------------------- baseline / diff */

async function cmdBaseline() {
  const { sessions } = await loadCorpus();
  const snap = saveBaseline(sessions, { note: 'pre-Governor' });
  if (!snap) { console.error('  no usable sessions to baseline'); process.exit(1); }
  const m = snap.metrics;
  console.log(`\n  ${B}Baseline recorded${R}`);
  head('SNAPSHOT');
  console.log(`  sessions                ${m.sessions}`);
  console.log(`  tokens / request        ${fmtTok(m.tokensPerRequest)}`);
  console.log(`  requests / session      ${m.requestsPerSession.toFixed(1)} ${D}(turns-to-completion proxy)${R}`);
  console.log(`  median peak context     ${fmtTok(m.medianPeakContext)}`);
  console.log(`  compactions / session   ${m.compactionsPerSession.toFixed(2)}`);
  console.log(`\n  ${D}Use Claude Code normally for a week, then run ${B}governor diff${R}${D}.`);
  console.log(`  Only sessions created after now are compared.${R}\n`);
}

/* --------------------------------------------------------------- on / off */

async function cmdOn() {
  const cfg = loadConfig();
  saveConfig({ ...cfg, enabled: true });
  // Mechanical, not LLM: on/off must fully own the CLAUDE.md rules too, or "off" is a lie —
  // the rules would keep silently shaping every plan/response while the toggle says OFF.
  for (const [id, block] of CLAUDE_MD_BLOCKS) upsertBlock(claudeMdPath(), id, block);
  console.log(`\n  ${G}Governor ON.${R} CLAUDE.md rules restored; the statusline will show it on the next update.\n`);
}

async function cmdOff() {
  const cfg = loadConfig();
  saveConfig({ ...cfg, enabled: false });
  for (const [id] of CLAUDE_MD_BLOCKS) removeBlock(claudeMdPath(), id);
  console.log(`\n  ${Y}Governor OFF.${R} Hooks, the statusline additions, and the CLAUDE.md`);
  console.log(`  rules all stop — nothing is left quietly active. Your original statusline`);
  console.log(`  (if any) still renders underneath. ${D}governor on${R} to resume.\n`);
}

async function cmdDiff() {
  const { sessions } = await loadCorpus();
  const base = loadBaseline();
  const res = compare(sessions, base);

  console.log(`\n  ${B}Governor — did it actually help?${R}`);
  if (res.error) {
    console.log(`\n  ${Y}${res.error}${R}\n`);
    return;
  }

  const arrow = (d) => (d < 0 ? `${G}${pct(d)}${R}` : d > 0 ? `${RD}+${pct(d)}${R}` : `${D}0%${R}`);
  head('AFTER vs BASELINE');
  console.log(`  ${pad('METRIC', 26)}${lpad('BEFORE', 13)}${lpad('AFTER', 13)}${lpad('CHANGE', 12)}`);
  const row = (label, key, fmt = fmtTok) =>
    console.log(`  ${pad(label, 26)}${lpad(fmt(res.was[key]), 13)}${lpad(fmt(res.now[key]), 13)}${lpad(arrow(res.deltas[key]), 12)}`);
  row('tokens / request', 'tokensPerRequest');
  row('median peak context', 'medianPeakContext');
  row('requests / session', 'requestsPerSession', (v) => v.toFixed(1));
  row('output / request', 'outputPerRequest');
  console.log(`  ${pad('compactions / session', 26)}${lpad(res.was.compactionsPerSession.toFixed(2), 13)}${lpad(res.now.compactionsPerSession.toFixed(2), 13)}`);

  const colour = res.verdict.startsWith('IMPROVED') ? G : res.verdict.startsWith('NO') ? D : RD;
  console.log(`\n  ${colour}${B}${res.verdict}${R}`);
  if (res.verdict.startsWith('REGRESSION')) {
    console.log(`  ${D}Fewer tokens but more turns is not a win. Raise the window percentage`);
    console.log(`  in config.json, or run ${B}governor uninstall${R}${D}.${R}`);
  }
  console.log(`  ${D}Based on ${res.now.sessions} sessions since the baseline.${R}\n`);
}

/* -------------------------------------------------------------------- impact */

async function cmdImpact() {
  const target = process.argv[3];
  if (!target) { console.error('  usage: governor impact <file>'); process.exit(1); }
  const root = process.cwd();
  const index = loadIndex(root);
  if (!index) {
    console.error(`\n  No route map here. Run: ${B}governor routes .${R}\n`);
    process.exit(1);
  }

  const r = impactOf(index, target);
  if (r.error) {
    console.error(`\n  ${Y}${r.error}${R}`);
    if (r.candidates) for (const c of r.candidates) console.error(`    ${c}`);
    console.error();
    process.exit(1);
  }

  const colour = { isolated: G, low: G, medium: Y, high: RD }[r.risk];
  console.log(`\n  ${B}Blast radius — ${r.entry.path}${R}`);
  console.log(`  ${colour}${r.risk.toUpperCase()}${R} · ${r.totalDependents} dependent file(s)`);

  head('EXPORTS  (what other code relies on)');
  console.log(`  ${r.entry.symbols.length ? r.entry.symbols.join(', ') : '(none detected)'}`);

  head('UPSTREAM  (what this depends on — the cause may be here)');
  if (!r.upstream.length) console.log(`  ${D}(no local dependencies)${R}`);
  for (const u of r.upstream) console.log(`  ← ${u}`);

  head('DOWNSTREAM  (what a fix here can break)');
  if (!r.downstreamLevels.length) console.log(`  ${D}(nothing imports this — safe to change in isolation)${R}`);
  r.downstreamLevels.forEach((lvl, i) => {
    console.log(`  ${D}depth ${i + 1}${R}`);
    for (const p of lvl) console.log(`    → ${p}`);
  });

  console.log(`\n  ${D}Verify every DOWNSTREAM file still works before calling the fix done.${R}\n`);
}

/* --------------------------------------------------------------------- audit */

async function cmdAudit() {
  console.log(`\n  ${B}Governor — always-on context audit${R}`);
  head('WHAT YOU PAY FOR ON EVERY REQUEST');
  const items = [];
  const add = (name, p) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) items.push({ name, tokens: Math.round(st.size / 4), path: p });
    } catch { /* absent */ }
  };
  add('user CLAUDE.md', path.join(configDir(), 'CLAUDE.md'));
  add('project CLAUDE.md', path.join(process.cwd(), 'CLAUDE.md'));

  const skillsDir = path.join(configDir(), 'skills');
  let skillCount = 0, skillDesc = 0;
  try {
    for (const d of fs.readdirSync(skillsDir)) {
      try {
        const body = fs.readFileSync(path.join(skillsDir, d, 'SKILL.md'), 'utf8');
        const m = body.match(/^description:\s*(.+)$/m);
        if (m) { skillCount++; skillDesc += m[1].length; }
      } catch { /* skip */ }
    }
  } catch { /* none */ }
  if (skillCount) items.push({ name: `${skillCount} skill descriptions`, tokens: Math.round(skillDesc / 4), path: skillsDir });

  let total = 0;
  for (const i of items.sort((a, b) => b.tokens - a.tokens)) {
    total += i.tokens;
    console.log(`  ${lpad(fmtTok(i.tokens), 8)} tok  ${pad(i.name, 26)} ${D}${i.path}${R}`);
  }
  console.log(`  ${lpad(fmtTok(total), 8)} tok  ${B}total measured always-on${R}`);
  const s = loadConfig();
  const sc = selfCost();
  head("GOVERNOR'S OWN COST");
  for (const a of sc.alwaysOn) {
    // pad BEFORE colouring: ANSI codes count toward String.padStart length
    const t = lpad(a.tokens, 8);
    console.log(`  ${a.tokens === 0 ? G + t + R : t} tok  ${pad(a.what, 26)} ${D}${a.note}${R}`);
  }
  console.log(`  ${lpad(sc.alwaysOnTotal, 8)} tok  ${B}always-on total${R} ${D}(paid every request)${R}`);
  console.log();
  console.log(`  ${D}conditional, worst case:${R}`);
  for (const c of sc.conditional) {
    console.log(`  ${lpad(c.worst, 8)} tok  ${pad(c.what, 26)} ${D}${c.cap}${R}`);
  }
  if (!sc.installed) console.log(`  ${Y}(not installed yet — measured from templates)${R}`);
  console.log(`\n  ${D}Break-even: at ~64 requests/session the always-on cost is ~${fmtTok(sc.breakEven())} tokens.`);
  console.log(`  One avoided 40k re-read pays for it many times over.${R}`);

  console.log(`\n  ${D}Measured session floor in this corpus was ~25k tokens (system prompt,`);
  console.log(`  tool schemas and skill listing dominate; the files above are the part you control).${R}`);
  console.log(`  ${D}skillListingMaxDescChars caps the listing natively — Governor sets it to 800.${R}\n`);
}

/* ----------------------------------------------------------------------- cli */

function usage() {
  console.log(`
  ${B}governor${R} — make Claude Code aware of what it spends

    ${B}report${R}       where your tokens actually went
    ${B}tune${R} [model] size the compaction window against your own sessions
    ${B}gate0${R}        show observed compactions — does compaction fire, and where
    ${B}train${R}        train your Claude Code — window policy, hooks, statusline, agents, skills
      ${D}--dry-run${R}  show what would change, write nothing
    ${B}untrain${R}      remove everything, restore your previous statusline
    ${B}on${R} / ${B}off${R}    pause or resume, without untraining — statusline shows which
    ${B}verify${R}       plain-language check: is it actually working right now
    ${B}doctor${R}       probe capabilities and show current state
    ${B}routes${R} [dir] build ROUTES.md so Claude stops re-reading the codebase
    ${B}impact${R} FILE  blast radius: what a change here can break
    ${B}audit${R}        what you pay for on every single request
    ${B}baseline${R}     snapshot today's cost, to prove whether this helps
    ${B}diff${R}         compare against the baseline — reports regressions honestly

  100% local. No network. Reads ${projectsDir()}
`);
}

const cmd = process.argv[2];
const flags = process.argv.slice(3);
try {
  switch (cmd) {
    case 'report': await cmdReport(); break;
    case 'tune': await cmdTune(); break;
    case 'gate0': await cmdGate0(); break;
    case 'train': case 'install': await cmdInstall(flags.includes('--dry-run')); break;
    case 'untrain': case 'uninstall': case 'remove': await cmdUninstall(); break;
    case 'on': await cmdOn(); break;
    case 'off': await cmdOff(); break;
    case 'verify': await cmdVerify(); break;
    case 'doctor': await cmdDoctor(); break;
    case 'routes': await cmdRoutes(); break;
    case 'audit': await cmdAudit(); break;
    case 'baseline': await cmdBaseline(); break;
    case 'diff': await cmdDiff(); break;
    case 'impact': await cmdImpact(); break;
    case undefined: case '-h': case '--help': case 'help': usage(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
} catch (err) {
  console.error(`\n  governor failed: ${err?.message || err}\n`);
  process.exit(1);
}
