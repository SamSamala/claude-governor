#!/usr/bin/env node
/**
 * Governor warm restart.
 *
 * SessionStart can return `additionalContext`, `initialUserMessage` and `reloadSkills`.
 * When a fresh session begins in a directory holding a HANDOFF.md, we inject it — so
 * work resumes from a ~2k-token brief instead of replaying a 400k-token history.
 *
 * Default is `additionalContext` (Claude knows, waits for you). `autoResume: true`
 * switches to `initialUserMessage`, which makes it pick the work straight back up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/state.mjs';

const MAX_CHARS = 8000; // ~2k tokens — the startup budget from the plan

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function findHandoff(cwd) {
  const p = path.join(cwd || process.cwd(), 'HANDOFF.md');
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0) return null;
    let text = fs.readFileSync(p, 'utf8');
    if (/^\s*<!--\s*governor:done\s*-->/im.test(text)) return null; // completed, do not resurrect
    let truncated = false;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncated = true;
    }
    return { path: p, text, truncated, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

function main() {
  const raw = readStdin();
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* ignore */ }

  const cfg = loadConfig();
  if (cfg.enabled === false) return;

  // `resume` already carries the conversation; injecting again would duplicate it.
  const source = payload?.source;
  if (source === 'resume') return;

  const h = findHandoff(payload?.cwd);
  if (!h) return;

  const age = Math.round((Date.now() - h.mtime) / 60_000);
  const body = [
    `<governor-handoff path="${h.path}" age_minutes="${age}">`,
    `A previous session ended near the 5-hour usage limit and left this handoff.`,
    `Treat it as the source of truth for where the work stands. Do NOT redo anything`,
    `listed as done, and do not re-read files the handoff already summarises unless the`,
    `next step actually requires them.`,
    ``,
    h.text,
    h.truncated ? `\n[handoff truncated at ${MAX_CHARS} chars to protect the startup budget]` : '',
    `</governor-handoff>`,
  ].join('\n');

  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      reloadSkills: true,
    },
  };

  if (cfg.autoResume === true) {
    out.hookSpecificOutput.initialUserMessage =
      `${body}\n\nResume from the NEXT step in the handoff above.`;
  } else {
    out.hookSpecificOutput.additionalContext =
      `${body}\n\nWhen the user asks to continue, resume from the NEXT step. ` +
      `Mention in one line that a handoff was loaded.`;
  }

  process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch {
  // Never block session startup.
}
process.exit(0);
