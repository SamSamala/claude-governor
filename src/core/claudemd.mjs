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
mismatch, network call, ambiguous flag, external service). Skip steps that
essentially cannot fail (mkdir, writing a file). Planning for errors that
won't happen wastes as many tokens as skipping the ones that will.
`.trim();
