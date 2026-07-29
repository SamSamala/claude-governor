import path from 'node:path';
import fsSync from 'node:fs';
import { readRecords, usageOf, contextTokens, isSubagent, blocksOf, estimateTokens, isCompactBoundary } from './parse.mjs';
import { costOf, retentionCost, familyOf } from './price.mjs';

const BIG_RESULT_TOKENS = 5000;

/**
 * Single streaming pass over one transcript.
 * Returns a per-session summary plus the oversized tool results found in it.
 */
export async function analyzeSession(file) {
  let mtime = 0;
  try { mtime = fsSync.statSync(file).mtimeMs; } catch { /* keep 0 */ }
  const s = {
    file,
    mtime,
    project: path.basename(path.dirname(file)),
    requests: 0,
    subagentRequests: 0,
    input: 0, output: 0, cacheRead: 0, write1h: 0, write5m: 0, unsplitWrite: 0,
    subagentInput: 0, mainInput: 0,
    cost: 0,
    compactions: 0,
    models: new Set(),
    ctxTrail: [],       // context size per request, in order
    toolResults: [],    // { tokens, tool, index }
  };

  // tool_use id -> tool name, so a tool_result can be attributed to its tool
  const toolNameById = new Map();

  for await (const rec of readRecords(file)) {
    if (isCompactBoundary(rec)) s.compactions++;

    for (const b of blocksOf(rec)) {
      if (b.type === 'tool_use') {
        if (typeof b.id === 'string') toolNameById.set(b.id, b.name || '?');
      } else if (b.type === 'tool_result') {
        const tokens = estimateTokens(b.content);
        if (tokens > 0) {
          s.toolResults.push({
            tokens,
            tool: toolNameById.get(b.tool_use_id) || '?',
            index: s.requests,
          });
        }
      }
    }

    const u = usageOf(rec);
    if (!u) continue;

    const model = rec?.message?.model || '';
    s.models.add(model || 'unknown');

    const ctx = contextTokens(u);
    s.requests++;
    s.input += u.input;
    s.output += u.output;
    s.cacheRead += u.cacheRead;
    s.write1h += u.write1h;
    s.write5m += u.write5m;
    s.unsplitWrite += u.unsplitWrite;
    s.cost += costOf(u, model);
    s.ctxTrail.push(ctx);

    if (isSubagent(rec)) {
      s.subagentRequests++;
      s.subagentInput += ctx;
    } else {
      s.mainInput += ctx;
    }
  }

  s.totalInput = s.mainInput + s.subagentInput;
  s.models = [...s.models];
  s.primaryModel = s.models.find((m) => m && m !== 'unknown') || 'unknown';
  return s;
}

/** Aggregate many sessions into the report model. */
export async function analyzeAll(files, { onProgress } = {}) {
  const sessions = [];
  let done = 0;
  for (const f of files) {
    try {
      const s = await analyzeSession(f);
      if (s.requests > 0) sessions.push(s);
    } catch {
      // one bad transcript must never kill the run
    }
    if (onProgress) onProgress(++done, files.length);
  }

  const agg = {
    sessions: sessions.length,
    requests: 0, subagentRequests: 0,
    input: 0, output: 0, cacheRead: 0, write1h: 0, write5m: 0, unsplitWrite: 0,
    cost: 0, compactions: 0,
    mainInput: 0, subagentInput: 0,
  };
  for (const s of sessions) {
    agg.requests += s.requests;
    agg.subagentRequests += s.subagentRequests;
    agg.input += s.input; agg.output += s.output;
    agg.cacheRead += s.cacheRead;
    agg.write1h += s.write1h; agg.write5m += s.write5m; agg.unsplitWrite += s.unsplitWrite;
    agg.cost += s.cost;
    agg.compactions += s.compactions;
    agg.mainInput += s.mainInput;
    agg.subagentInput += s.subagentInput;
  }

  agg.totalInput = agg.mainInput + agg.subagentInput;
  const writes = agg.write1h + agg.write5m + agg.unsplitWrite;
  agg.cacheHitRate = (agg.cacheRead + writes) > 0 ? agg.cacheRead / (agg.cacheRead + writes) : 0;
  agg.subagentShare = agg.totalInput > 0 ? agg.subagentInput / agg.totalInput : 0;

  // Power law: sessions ranked by total input tokens
  const ranked = [...sessions].sort((a, b) => b.totalInput - a.totalInput);
  const top5 = ranked.slice(0, 5).reduce((n, s) => n + s.totalInput, 0);
  agg.top5Share = agg.totalInput > 0 ? top5 / agg.totalInput : 0;

  // Tool result concentration
  const all = sessions.flatMap((s) => s.toolResults);
  all.sort((a, b) => b.tokens - a.tokens);
  const toolTotal = all.reduce((n, r) => n + r.tokens, 0);
  const big = all.filter((r) => r.tokens > BIG_RESULT_TOKENS);
  const bigSum = big.reduce((n, r) => n + r.tokens, 0);

  agg.tool = {
    count: all.length,
    tokens: toolTotal,
    bigCount: big.length,
    bigTokens: bigSum,
    bigCountShare: all.length ? big.length / all.length : 0,
    bigTokenShare: toolTotal ? bigSum / toolTotal : 0,
    largest: all[0]?.tokens || 0,
    top10Share: toolTotal ? all.slice(0, 10).reduce((n, r) => n + r.tokens, 0) / toolTotal : 0,
    top100Share: toolTotal ? all.slice(0, 100).reduce((n, r) => n + r.tokens, 0) / toolTotal : 0,
  };

  return { agg, sessions, ranked };
}

/**
 * Retention attribution — the differentiator.
 * Cost of a tool result = size x turns it remained in context x cache-read rate.
 */
export function retentionOffenders(sessions, limit = 10) {
  const out = [];
  for (const s of sessions) {
    for (const r of s.toolResults) {
      if (r.tokens <= BIG_RESULT_TOKENS) continue;
      const turnsRemaining = Math.max(0, s.requests - r.index);
      out.push({
        session: s.file,
        project: s.project,
        tool: r.tool,
        tokens: r.tokens,
        admittedAtTurn: r.index,
        totalTurns: s.requests,
        turnsRemaining,
        cost: retentionCost(r.tokens, turnsRemaining, s.primaryModel),
      });
    }
  }
  out.sort((a, b) => b.cost - a.cost);
  return out.slice(0, limit);
}

export { BIG_RESULT_TOKENS, familyOf };
