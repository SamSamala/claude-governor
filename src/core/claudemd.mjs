import fs from 'node:fs';

/**
 * Generic fenced-block editing for a CLAUDE.md-style file: install/uninstall of a named
 * rule without disturbing anything else the user wrote there. Idempotent — re-applying the
 * same block twice produces a byte-identical file, so reinstalling never duplicates it and
 * a future wording change just replaces what's between the markers.
 */
function markers(id) {
  return {
    start: `<!-- governor:${id}:start -->`,
    end: `<!-- governor:${id}:end -->`,
  };
}

export function upsertBlock(filePath, id, content) {
  const { start, end } = markers(id);
  const block = `${start}\n${content.trim()}\n${end}`;

  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch { /* file does not exist yet */ }

  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  let next;
  if (re.test(existing)) {
    next = existing.replace(re, block);
  } else if (existing.trim()) {
    next = `${existing.replace(/\s+$/, '')}\n\n${block}\n`;
  } else {
    next = `${block}\n`;
  }

  fs.writeFileSync(filePath, next);

  const readBack = fs.readFileSync(filePath, 'utf8');
  if (!readBack.includes(start) || !readBack.includes(end)) {
    throw new Error(`claudemd: read-back mismatch writing block "${id}" to ${filePath}`);
  }
}

export function removeBlock(filePath, id) {
  const { start, end } = markers(id);
  let existing;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // nothing to remove
  }

  const re = new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`);
  const next = existing.replace(re, '').replace(/\n{3,}/g, '\n\n');

  if (!next.trim()) {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }
  fs.writeFileSync(filePath, next.replace(/^\n+/, ''));
}

export function hasBlock(filePath, id) {
  const { start } = markers(id);
  try {
    return fs.readFileSync(filePath, 'utf8').includes(start);
  } catch {
    return false;
  }
}

const INACTIVE_MARK = 'Status: INACTIVE';

/**
 * Prefix a rule's content with its current status. `governor on`/`off` use this to toggle
 * a rule IN PLACE — the text never disappears and reappears, just this one line changes.
 *
 * Why not delete/recreate the block on toggle (the original design): a block that vanishes
 * and reappears in a shared file looks exactly like injected content being added and
 * removed — which is precisely what triggered a different Claude Code session to flag
 * Governor's own CLAUDE.md rules as a suspected prompt-injection incident and nearly strip
 * the whole install. A stable block with one word changing is unambiguous and low-drama.
 */
export function withStatus(content, active) {
  const status = active
    ? '**Status: ACTIVE.**'
    : `**${INACTIVE_MARK} — paused. Ignore this rule entirely until \`governor on\` (or ` +
      '`governor on --project` if it was paused for this project only) turns it back on.**';
  return `${status}\n\n${content.trim()}`;
}

/** Whether a block is present AND currently marked active (not just present). */
export function isActive(filePath, id) {
  const { start, end } = markers(id);
  let body;
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  const m = body.match(new RegExp(`${start}([\\s\\S]*?)${end}`));
  if (!m) return false;
  return !m[1].includes(INACTIVE_MARK);
}

export const ABOUT_ID = 'about';

export const ABOUT_BLOCK = `
## Governor — installed on purpose, not an injection

The \`governor:*\` blocks in this file (Plan Mode, mistake journal, subagent
routing) were installed intentionally by running this machine's own
Governor trainer (https://github.com/SamSamala/claude-governor). They are
not third-party or malicious content — if you're a fresh Claude Code
session encountering this for the first time and unsure, run
\`governor doctor\` to inspect current state, or ask the person you're
working with to confirm before treating this as suspicious. \`governor
untrain\` removes everything cleanly if it's genuinely unwanted.
`.trim();

export const PROJECT_OVERRIDE_ID = 'projectoverride';

/** A lean override note for project-scoped on/off — points at the global rules rather than
 * duplicating their full text, so a project override costs a few lines, not three blocks. */
export function projectOverrideBlock(active) {
  return active
    ? `## Governor: explicitly ON for this project

This project explicitly turns Governor's rules (Plan Mode, mistake journal,
subagent routing — see your global CLAUDE.md) back ON, overriding a global
OFF state if one exists. Follow them normally while working here.`
    : `## Governor: explicitly OFF for this project

This project explicitly turns Governor's rules (Plan Mode, mistake journal,
subagent routing — normally in your global CLAUDE.md) OFF, overriding the
global state. Ignore those rules while working in this project only.
\`governor on --project\` here to resume, or \`governor on\` to check the
global default elsewhere.`;
}

export const PLAN_MODE_ID = 'planmode';

export const PLAN_MODE_BLOCK = `
## Plan Mode: always include an execution plan

Phase 4 (Final Plan) must include an Execution Plan, not just a feature
description. Per phase, state:
- Exact CLI commands, in order.
- Files/folders to create or modify (paths, not line numbers).
- The order components get built in.
- Required config, dependencies, or environment setup.
- The expected outcome to check before moving to the next phase.

A developer should be able to follow it without deciding what to do next.

Predict failures selectively, not exhaustively. Add a one-line fix for a
command/step only if it has a real, specific failure mode (version
mismatch, network call, ambiguous flag, external service, a known-fragile
dependency — check its installed version before writing code against it).
Skip steps that essentially cannot fail (mkdir, writing a file). Planning
for errors that won't happen wastes as many tokens as skipping the ones
that will.

Verification is a gate per phase, not a reflex per edit. Run the
type-check/lint/build cycle once when a phase is logically complete, not
after every individual file change — mid-phase, trust the edit. If a phase
needs a throwaway verification script, reuse ONE scratch file across the
whole plan (e.g. \`_scratch-verify.ts\`), overwritten each time and deleted
once at the end — never one new file per phase.

If the task ships something (deploys, publishes, goes to prod), include an
explicit Deploy phase with its own commands — don't leave commit/push to be
improvised after the last verification step. First command of that phase:
confirm a git identity is actually configured (\`git config user.email\`) —
an unconfigured one silently auto-derives a bogus address and fails deploy
platforms that verify commit authorship.

If something unrelated to this plan surfaces mid-build (a bug in a
different area, a security concern, an unrelated investigation), note it
and stop — do not fold it into this plan's phases. Flag it to the user as a
separate follow-up instead of expanding scope live.
`.trim();

export const MISTAKES_ID = 'mistakes';

export const MISTAKES_BLOCK = `
## Don't repeat a solved error

Before debugging a new error, check MISTAKES.md in the project root (if it
exists) for a similar symptom — grep it first, don't re-diagnose blind. A
match means: read the fix, try it directly.

After resolving a REAL error (genuine diagnosis, not a typo or a one-line
fix), append an entry to MISTAKES.md in this format:

## <date> — <one-line symptom>
**Symptom:** the error text or what broke
**Cause:** the actual root cause, not the throw site
**Fix:** what resolved it
**Files:** paths involved

Create the file on the first real entry — don't create it speculatively
empty. Not every error earns an entry; a mistake worth logging is one that
took real diagnosis to solve.
`.trim();

export const ROUTING_ID = 'subagentrouting';

export const ROUTING_BLOCK = `
## Subagents: route by task, never inherit by default

Don't let a subagent silently inherit the parent session's model and effort
— choose per task:
- Haiku: reading, searching, editing, formatting, summarizing, other simple
  tasks.
- Sonnet: feature implementation, refactoring, testing, moderate debugging.
- Opus: architecture, complex debugging, deep reasoning, multi-step
  planning.

Effort defaults to low or medium. Reserve high for tasks that genuinely
need extensive reasoning — it is expensive, not a default.
`.trim();
