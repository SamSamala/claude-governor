import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolve the Claude Code config directory.
 * Never hardcode ~/.claude — CLAUDE_CONFIG_DIR is supported and used in the wild.
 * (Failure mode #15 in the plan.)
 */
export function configDir() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(homedir(), '.claude');
}

export function projectsDir() {
  return path.join(configDir(), 'projects');
}

export function governorDir() {
  return path.join(configDir(), 'governor');
}

export function settingsPath() {
  return path.join(configDir(), 'settings.json');
}

/** Recursively collect *.jsonl transcripts. Returns [] rather than throwing. */
export function findTranscripts(root = projectsDir()) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never crash
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}
