import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  upsertBlock, removeBlock, hasBlock,
  PLAN_MODE_ID, PLAN_MODE_BLOCK, MISTAKES_ID, MISTAKES_BLOCK,
} from '../src/core/claudemd.mjs';

function sandboxFile(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-claudemd-'));
  const p = path.join(dir, 'CLAUDE.md');
  if (initial !== undefined) fs.writeFileSync(p, initial);
  return p;
}

test('upsertBlock creates the file when none exists', () => {
  const p = sandboxFile();
  upsertBlock(p, PLAN_MODE_ID, PLAN_MODE_BLOCK);
  const body = fs.readFileSync(p, 'utf8');
  assert.ok(hasBlock(p, PLAN_MODE_ID));
  assert.match(body, /Execution Plan/);
});

test('upsertBlock preserves unrelated existing content', () => {
  const p = sandboxFile('# My notes\n\nRemember to feed the cat.\n');
  upsertBlock(p, PLAN_MODE_ID, PLAN_MODE_BLOCK);
  const body = fs.readFileSync(p, 'utf8');
  assert.match(body, /Remember to feed the cat\./, 'user content survives');
  assert.ok(hasBlock(p, PLAN_MODE_ID));
});

test('upsertBlock is idempotent — no duplication, byte-identical on reapply', () => {
  const p = sandboxFile('# My notes\n\nRemember to feed the cat.\n');
  upsertBlock(p, PLAN_MODE_ID, PLAN_MODE_BLOCK);
  const once = fs.readFileSync(p, 'utf8');
  upsertBlock(p, PLAN_MODE_ID, PLAN_MODE_BLOCK);
  const twice = fs.readFileSync(p, 'utf8');
  assert.equal(twice, once, 'second apply changes nothing');
  const occurrences = twice.split('governor:planmode:start').length - 1;
  assert.equal(occurrences, 1, 'exactly one block, never duplicated');
});

test('upsertBlock replaces stale content between markers on a wording change', () => {
  const p = sandboxFile();
  upsertBlock(p, PLAN_MODE_ID, 'old wording');
  upsertBlock(p, PLAN_MODE_ID, 'new wording');
  const body = fs.readFileSync(p, 'utf8');
  assert.match(body, /new wording/);
  assert.doesNotMatch(body, /old wording/);
});

test('removeBlock strips only our block, keeps user content', () => {
  const p = sandboxFile('# My notes\n\nRemember to feed the cat.\n');
  upsertBlock(p, PLAN_MODE_ID, PLAN_MODE_BLOCK);
  removeBlock(p, PLAN_MODE_ID);
  const body = fs.readFileSync(p, 'utf8');
  assert.match(body, /Remember to feed the cat\./, 'user content survives removal');
  assert.equal(hasBlock(p, PLAN_MODE_ID), false);
  assert.doesNotMatch(body, /governor:planmode/);
});

test('removeBlock deletes the file entirely when our block was the only content', () => {
  const p = sandboxFile();
  upsertBlock(p, PLAN_MODE_ID, PLAN_MODE_BLOCK);
  assert.ok(fs.existsSync(p));
  removeBlock(p, PLAN_MODE_ID);
  assert.equal(fs.existsSync(p), false, 'no orphaned empty stub left behind');
});

test('removeBlock on a file that never had the block is a harmless no-op', () => {
  const p = sandboxFile('# My notes\n\nRemember to feed the cat.\n');
  const before = fs.readFileSync(p, 'utf8');
  removeBlock(p, PLAN_MODE_ID);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
});

test('removeBlock on a missing file does not throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-claudemd-'));
  assert.doesNotThrow(() => removeBlock(path.join(dir, 'CLAUDE.md'), PLAN_MODE_ID));
});

test('two different blocks coexist in the same file without colliding', () => {
  const p = sandboxFile();
  upsertBlock(p, PLAN_MODE_ID, PLAN_MODE_BLOCK);
  upsertBlock(p, MISTAKES_ID, MISTAKES_BLOCK);
  assert.ok(hasBlock(p, PLAN_MODE_ID));
  assert.ok(hasBlock(p, MISTAKES_ID));

  removeBlock(p, MISTAKES_ID);
  assert.equal(hasBlock(p, MISTAKES_ID), false, 'only the targeted block is removed');
  assert.ok(hasBlock(p, PLAN_MODE_ID), 'the other block survives untouched');
});
