import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRecords, usageOf, contextTokens, isSubagent } from '../src/core/parse.mjs';
import { analyzeSession } from '../src/core/analyze.mjs';

function tmpFile(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-')), 'session.jsonl');
  fs.writeFileSync(p, contents);
  return p;
}

const mkAssistant = (usage, extra = {}) => JSON.stringify({
  type: 'assistant',
  message: { model: 'claude-sonnet-5', usage },
  ...extra,
});

test('malformed JSONL degrades instead of crashing', async () => {
  const file = tmpFile([
    mkAssistant({ input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100 }),
    '{ this is not json',
    '',
    'not even close',
    '{"truncated": ',
    mkAssistant({ input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 200 }),
  ].join('\n'));

  const recs = [];
  for await (const r of readRecords(file)) recs.push(r);
  assert.equal(recs.length, 2, 'good lines survive, bad lines are skipped');
});

test('a file that does not exist yields nothing rather than throwing', async () => {
  const recs = [];
  for await (const r of readRecords('/nope/does/not/exist.jsonl')) recs.push(r);
  assert.equal(recs.length, 0);
});

test('usage normalization tolerates missing and hostile fields', () => {
  assert.equal(usageOf({}), null);
  assert.equal(usageOf({ message: {} }), null);
  assert.equal(usageOf({ message: { usage: 'nope' } }), null);

  const u = usageOf({ message: { usage: {
    input_tokens: 5, output_tokens: -3, cache_read_input_tokens: null,
    cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 20 },
  } } });
  assert.equal(u.input, 5);
  assert.equal(u.output, 0, 'negative clamped to 0');
  assert.equal(u.cacheRead, 0, 'null clamped to 0');
  assert.equal(u.cacheWrite, 120);
});

test('falls back to the flat cache_creation field when the 1h/5m split is absent', () => {
  const u = usageOf({ message: { usage: { cache_creation_input_tokens: 777 } } });
  assert.equal(u.cacheWrite, 777);
  assert.equal(u.unsplitWrite, 777, 'attributed to 5m for pricing, not silently dropped');
});

test('contextTokens = everything the model had to be given', () => {
  const u = usageOf({ message: { usage: {
    input_tokens: 10, cache_read_input_tokens: 1000,
    cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
  } } });
  assert.equal(contextTokens(u), 1110);
});

test('subagent records are identified via isSidechain', () => {
  assert.equal(isSubagent({ isSidechain: true }), true);
  assert.equal(isSubagent({ isSidechain: false }), false);
  assert.equal(isSubagent({}), false);
});

test('session analysis attributes tool results to their tool and turn', async () => {
  const file = tmpFile([
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        usage: { input_tokens: 1, cache_read_input_tokens: 1000 },
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'x'.repeat(40_000) }] },
    }),
    mkAssistant({ input_tokens: 1, cache_read_input_tokens: 12_000 }),
  ].join('\n'));

  const s = await analyzeSession(file);
  assert.equal(s.requests, 2);
  assert.equal(s.toolResults.length, 1);
  assert.equal(s.toolResults[0].tool, 'Read', 'result attributed to the originating tool');
  assert.ok(s.toolResults[0].tokens > 9_000);
});

test('a session with zero usage records does not divide by zero', async () => {
  const file = tmpFile(JSON.stringify({ type: 'user', message: { content: 'hi' } }));
  const s = await analyzeSession(file);
  assert.equal(s.requests, 0);
  assert.equal(s.totalInput, 0);
});
