import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricsFor, compare } from '../src/core/proof.mjs';

/** Build a fake session with a given per-request context cost and turn count. */
const mk = (mtime, requests, tokensPerReq) => ({
  mtime,
  requests,
  totalInput: requests * tokensPerReq,
  output: requests * 500,
  compactions: 0,
  ctxTrail: Array.from({ length: requests }, () => tokensPerReq),
});

const baselineOf = (sessions, takenAt) => ({ takenAt, metrics: metricsFor(sessions) });

test('metrics are per-request, so they do not drift with session count', () => {
  const a = metricsFor([mk(1, 10, 100_000)]);
  const b = metricsFor([mk(1, 10, 100_000), mk(2, 10, 100_000), mk(3, 10, 100_000)]);
  assert.equal(a.tokensPerRequest, b.tokensPerRequest);
  assert.equal(a.requestsPerSession, b.requestsPerSession);
});

test('reports IMPROVED when tokens per request fall and turns hold', () => {
  const base = baselineOf([mk(1, 20, 400_000)], 1000);
  const after = [mk(2000, 20, 150_000), mk(2001, 21, 150_000), mk(2002, 19, 150_000)];
  const r = compare(after, base);
  assert.equal(r.verdict, 'IMPROVED');
  assert.ok(r.deltas.tokensPerRequest < -0.5);
});

test('reports REGRESSION when tokens fall but turns balloon — a token win that costs turns is a loss', () => {
  const base = baselineOf([mk(1, 20, 400_000)], 1000);
  // Half the tokens per request, but nearly double the turns to finish.
  const after = [mk(2000, 38, 200_000), mk(2001, 39, 200_000), mk(2002, 40, 200_000)];
  const r = compare(after, base);
  assert.match(r.verdict, /^REGRESSION/);
  assert.ok(r.deltas.tokensPerRequest < 0, 'tokens did fall');
  assert.ok(r.deltas.requestsPerSession > 0.2, 'but turns rose');
});

test('reports WORSE when it made things more expensive', () => {
  const base = baselineOf([mk(1, 20, 100_000)], 1000);
  const after = [mk(2000, 20, 300_000), mk(2001, 20, 300_000), mk(2002, 20, 300_000)];
  assert.equal(compare(after, base).verdict, 'WORSE');
});

test('reports NO CHANGE rather than inventing a win from noise', () => {
  const base = baselineOf([mk(1, 20, 200_000)], 1000);
  const after = [mk(2000, 20, 202_000), mk(2001, 20, 199_000), mk(2002, 20, 201_000)];
  assert.equal(compare(after, base).verdict, 'NO CHANGE');
});

test('refuses to compare without enough post-baseline data', () => {
  const base = baselineOf([mk(1, 20, 200_000)], 1000);
  const r = compare([mk(2000, 20, 50_000)], base);
  assert.match(r.error, /need 3/);
  assert.equal(r.verdict, undefined, 'no verdict from one session');
});

test('only counts sessions recorded AFTER the baseline', () => {
  const base = baselineOf([mk(1, 20, 400_000)], 5000);
  const mixed = [
    mk(100, 20, 400_000), mk(200, 20, 400_000),   // before — must be ignored
    mk(9000, 20, 100_000), mk(9001, 20, 100_000), mk(9002, 20, 100_000),
  ];
  const r = compare(mixed, base);
  assert.equal(r.now.sessions, 3, 'pre-baseline sessions excluded');
  assert.equal(r.verdict, 'IMPROVED');
});

test('missing baseline is an explicit error, not a fabricated result', () => {
  assert.match(compare([mk(1, 5, 1000)], null).error, /no baseline/);
});
