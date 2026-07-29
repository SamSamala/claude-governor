import path from 'node:path';

/**
 * Blast radius.
 *
 * Answers "what else could this break?" from the route index instead of by reading the
 * repo. Debugging is a measured cost sink precisely because the usual move is to re-read
 * everything nearby; the dependency edges are already computed, so this costs ~0 tokens.
 *
 * Direction matters and is easy to get backwards:
 *   - upstream   = what this file imports  -> where the CAUSE may actually live
 *   - downstream = what imports this file  -> what a FIX may break
 */

function indexBy(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.path, e);
  return m;
}

/** Resolve a user-supplied path/basename to an indexed entry. */
export function resolveEntry(index, needle) {
  const entries = index?.entries || [];
  const norm = needle.replace(/^\.\//, '');
  let hit = entries.find((e) => e.path === norm);
  if (hit) return hit;
  hit = entries.find((e) => e.path.endsWith(`/${norm}`) || e.path === norm);
  if (hit) return hit;
  const base = path.basename(norm);
  const matches = entries.filter((e) => path.basename(e.path) === base);
  if (matches.length === 1) return matches[0];
  return matches.length ? { ambiguous: matches.map((m) => m.path) } : null;
}

/** Downstream: everything that (transitively) imports `start`. These are what a fix can break. */
export function downstream(index, start, maxDepth = 3) {
  const byPath = indexBy(index.entries);
  const levels = [];
  let frontier = new Set([start.path]);
  const seen = new Set([start.path]);

  for (let d = 0; d < maxDepth; d++) {
    const next = new Set();
    for (const p of frontier) {
      const e = byPath.get(p);
      for (const imp of e?.importedBy || []) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        next.add(imp);
      }
    }
    if (!next.size) break;
    levels.push([...next]);
    frontier = next;
  }
  return levels;
}

/** Upstream: what this file depends on. The cause is often here, not in the file that threw. */
export function upstream(index, start) {
  const byPath = indexBy(index.entries);
  const out = [];
  for (const imp of start.imports || []) {
    const resolved = path.normalize(path.join(path.dirname(start.path), imp)).replace(/\.[^.]+$/, '');
    const hit = index.entries.find(
      (e) => e.path.replace(/\.[^.]+$/, '') === resolved
        || e.path.replace(/\.[^.]+$/, '') === path.join(resolved, 'index')
    );
    if (hit) out.push(hit.path);
  }
  return out;
}

/**
 * Full impact report for one file.
 * `riskScore` is a crude fan-out count — it ranks where to be careful, nothing more.
 */
export function impactOf(index, needle) {
  const entry = resolveEntry(index, needle);
  if (!entry) return { error: `"${needle}" is not in the route map. Run \`governor routes .\` first.` };
  if (entry.ambiguous) return { error: `"${needle}" is ambiguous`, candidates: entry.ambiguous };

  const down = downstream(index, entry);
  const up = upstream(index, entry);
  const directDependents = down[0] || [];
  const totalDependents = down.flat().length;

  return {
    entry,
    upstream: up,
    downstreamLevels: down,
    directDependents,
    totalDependents,
    riskScore: totalDependents,
    risk: totalDependents === 0 ? 'isolated'
      : totalDependents <= 2 ? 'low'
      : totalDependents <= 8 ? 'medium'
      : 'high',
  };
}
