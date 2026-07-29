import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Defensive transcript reader.
 *
 * Contract (plan failure mode #12 — transcript schema drift):
 *   - Never assume a field exists.
 *   - A malformed line is skipped, not fatal.
 *   - A malformed FILE is skipped, not fatal.
 *   - Streams line-by-line: transcripts reach 24MB+.
 */

/** Async generator over parsed records in one transcript. Malformed lines are skipped. */
export async function* readRecords(file) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // truncated / corrupt line
      }
      if (rec && typeof rec === 'object') yield rec;
    }
  } catch {
    // stream died mid-file (truncated write) — yield what we got
  } finally {
    rl.close();
    stream?.destroy?.();
  }
}

/**
 * Normalize a record's usage block.
 * Returns null when the record carries no usage (user turns, meta records, etc).
 */
export function usageOf(rec) {
  const u = rec?.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const cc = (u.cache_creation && typeof u.cache_creation === 'object') ? u.cache_creation : {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

  const write1h = n(cc.ephemeral_1h_input_tokens);
  const write5m = n(cc.ephemeral_5m_input_tokens);
  // Fall back to the flat field when the split is absent (older/newer schema).
  const writeFlat = n(u.cache_creation_input_tokens);
  const writeSplit = write1h + write5m;

  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    write1h,
    write5m,
    // Trust the split when present; otherwise attribute the flat value to 5m.
    cacheWrite: writeSplit > 0 ? writeSplit : writeFlat,
    unsplitWrite: writeSplit > 0 ? 0 : writeFlat,
  };
}

/** Total input tokens billed for one request = everything the model had to be given. */
export function contextTokens(usage) {
  return usage.cacheRead + usage.cacheWrite + usage.input;
}

/** True when this record belongs to a subagent rather than the main thread. */
export function isSubagent(rec) {
  return rec?.isSidechain === true;
}

/** Iterate content blocks of a record's message, safely. */
export function* blocksOf(rec) {
  const c = rec?.message?.content;
  if (!Array.isArray(c)) return;
  for (const b of c) if (b && typeof b === 'object') yield b;
}

/** Rough token estimate for an arbitrary JSON payload (4 chars/token heuristic). */
export function estimateTokens(value) {
  if (value == null) return 0;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return Math.floor(s.length / 4);
  } catch {
    return 0;
  }
}

/** Detect a compaction boundary record. Several shapes have shipped; accept any. */
export function isCompactBoundary(rec) {
  return (
    rec?.isCompactSummary === true ||
    rec?.subtype === 'compact_boundary' ||
    rec?.type === 'compact_boundary'
  );
}
