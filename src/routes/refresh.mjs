import fs from 'node:fs';
import path from 'node:path';
import { scanRepo, renderRouteFiles, ROOT_BUDGET_BYTES } from './scan.mjs';

/**
 * Incremental refresh + staleness marking.
 *
 * Scanning is mechanical and cheap, so we always rescan; the point of "incremental"
 * is knowing exactly WHAT moved, so a stale pointer is surfaced rather than trusted.
 */

export const INDEX_FILE = '.governor-routes.json';

export function loadIndex(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, INDEX_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function saveIndex(root, index) {
  try {
    fs.writeFileSync(path.join(root, INDEX_FILE), JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

export function diffIndex(prev, next) {
  const prevByPath = new Map((prev?.entries || []).map((e) => [e.path, e]));
  const nextByPath = new Map(next.entries.map((e) => [e.path, e]));

  const added = [], changed = [], removed = [];
  for (const [p, e] of nextByPath) {
    const old = prevByPath.get(p);
    if (!old) added.push(p);
    else if (old.hash !== e.hash) changed.push(p);
  }
  for (const p of prevByPath.keys()) if (!nextByPath.has(p)) removed.push(p);
  return { added, changed, removed };
}

/**
 * Rebuild the map, marking entries that moved since the last run.
 * `removed` paths are the dangerous ones — those are the confident-but-wrong pointers.
 */
export function refresh(root) {
  const prev = loadIndex(root);
  const next = scanRepo(root);
  const delta = diffIndex(prev, next);

  const changedSet = new Set(delta.changed);
  for (const e of next.entries) {
    if (changedSet.has(e.path)) e.stale = true;
    // carry forward any human/cheap-model note when the file is unchanged
    if (!changedSet.has(e.path) && prev) {
      const old = (prev.entries || []).find((x) => x.path === e.path);
      if (old?.note) e.note = old.note;
    }
  }

  next.delta = delta;
  const { tiered, files } = renderRouteFiles(next);
  return { index: next, delta, tiered, files, budget: ROOT_BUDGET_BYTES };
}
