import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepo, renderRouteFiles, ROOT_BUDGET_BYTES } from '../src/routes/scan.mjs';
import { refresh, saveIndex } from '../src/routes/refresh.mjs';

/** Mirror the CLI: refresh() is pure; the caller persists the index. */
const scan = (dir) => { const r = refresh(dir); saveIndex(dir, r.index); return r; };
import { impactOf } from '../src/routes/impact.mjs';

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-repo-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

test('extracts exports including generators (a real miss: export async function*)', () => {
  const dir = repo({
    'a.mjs': 'export async function* stream(){}\nexport function plain(){}\nexport const K = 1;\nexport class C {}\n',
  });
  const idx = scanRepo(dir);
  const e = idx.entries.find((x) => x.path === 'a.mjs');
  assert.ok(e.symbols.includes('stream'), 'generator export detected');
  assert.ok(e.symbols.includes('plain'));
  assert.ok(e.symbols.includes('K'));
  assert.ok(e.symbols.includes('C'));
});

test('builds reverse dependency edges', () => {
  const dir = repo({
    'core.mjs': 'export function core(){}\n',
    'a.mjs': "import { core } from './core.mjs';\n",
    'b.mjs': "import { core } from './core.mjs';\n",
  });
  const idx = scanRepo(dir);
  const core = idx.entries.find((e) => e.path === 'core.mjs');
  assert.equal(core.importedBy.length, 2);
});

test('impact separates upstream (cause) from downstream (what a fix breaks)', () => {
  const dir = repo({
    'util.mjs': 'export function u(){}\n',
    'mid.mjs': "import { u } from './util.mjs';\nexport function m(){}\n",
    'top.mjs': "import { m } from './mid.mjs';\n",
  });
  const idx = scanRepo(dir);
  const r = impactOf(idx, 'mid.mjs');
  assert.deepEqual(r.upstream, ['util.mjs'], 'cause may live upstream');
  assert.deepEqual(r.downstreamLevels[0], ['top.mjs'], 'a fix here can break top.mjs');
  assert.equal(r.risk, 'low');
});

test('impact reports transitive downstream depth', () => {
  const dir = repo({
    'a.mjs': 'export function a(){}\n',
    'b.mjs': "import { a } from './a.mjs';\nexport function b(){}\n",
    'c.mjs': "import { b } from './b.mjs';\n",
  });
  const r = impactOf(scanRepo(dir), 'a.mjs');
  assert.deepEqual(r.downstreamLevels[0], ['b.mjs']);
  assert.deepEqual(r.downstreamLevels[1], ['c.mjs'], 'transitive dependents surfaced');
  assert.equal(r.totalDependents, 2);
});

test('impact flags an isolated file as safe to change', () => {
  const dir = repo({ 'lonely.mjs': 'export function x(){}\n' });
  const r = impactOf(scanRepo(dir), 'lonely.mjs');
  assert.equal(r.risk, 'isolated');
  assert.equal(r.totalDependents, 0);
});

test('impact errors clearly on an unknown file rather than guessing', () => {
  const r = impactOf(scanRepo(repo({ 'a.mjs': 'export function a(){}\n' })), 'nope.mjs');
  assert.match(r.error, /not in the route map/);
});

test('small repos get a single flat map', () => {
  const files = {};
  for (let i = 0; i < 10; i++) files[`m${i}.mjs`] = `export function f${i}(){}\n`;
  const { tiered, files: out } = renderRouteFiles(scanRepo(repo(files)));
  assert.equal(tiered, false);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'ROUTES.md');
});

test('LARGE repos switch to two-tier so the map never costs more than it saves', () => {
  const files = {};
  for (let i = 0; i < 600; i++) files[`pkg${Math.floor(i / 40)}/m${i}.mjs`] = `export function f${i}(){}\n`;
  const { tiered, files: out } = renderRouteFiles(scanRepo(repo(files)));

  assert.equal(tiered, true, '600 files must not produce a flat map');
  const root = out.find((f) => f.path === 'ROUTES.md');
  assert.ok(Buffer.byteLength(root.content) <= ROOT_BUDGET_BYTES,
    'root index must stay inside the per-session budget');
  assert.ok(out.length > 10, 'per-directory detail files emitted');
  assert.match(root.content, /ROUTES\.md/, 'root points at the detail files');
});

test('refresh marks changed files STALE — a confident wrong pointer is worse than none', () => {
  const dir = repo({ 'a.mjs': 'export function a(){}\n', 'b.mjs': 'export function b(){}\n' });
  scan(dir);
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export function aRenamed(){}\n');
  const { index, delta } = scan(dir);
  assert.deepEqual(delta.changed, ['a.mjs']);
  assert.equal(index.entries.find((e) => e.path === 'a.mjs').stale, true);
  assert.equal(index.entries.find((e) => e.path === 'b.mjs').stale, undefined);
});

test('refresh reports removed files so stale pointers are dropped', () => {
  const dir = repo({ 'a.mjs': 'export function a(){}\n', 'gone.mjs': 'export function g(){}\n' });
  scan(dir);
  fs.unlinkSync(path.join(dir, 'gone.mjs'));
  const { delta } = scan(dir);
  assert.deepEqual(delta.removed, ['gone.mjs']);
});

test('scanner skips dependency and build directories', () => {
  const dir = repo({
    'src/a.mjs': 'export function a(){}\n',
    'node_modules/pkg/index.mjs': 'export function nope(){}\n',
    'dist/bundle.mjs': 'export function nope2(){}\n',
  });
  const paths = scanRepo(dir).entries.map((e) => e.path);
  assert.deepEqual(paths, ['src/a.mjs']);
});
