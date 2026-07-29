import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWindow, isAcceptable, envOverride, resolveWindow,
  WINDOW_MIN, WINDOW_MAX, DEFAULT_PCT,
} from '../src/core/policy.mjs';

test('Sonnet 5: 50% of its real 1M window', () => {
  const d = computeWindow('claude-sonnet-5');
  assert.equal(d.family, 'sonnet');
  assert.equal(d.modelWindow, 1_000_000);
  assert.equal(d.target, 500_000);
  assert.equal(d.value, 500_000);
  assert.equal(d.clamped, false);
  assert.ok(isAcceptable(d.value), 'must survive the binary zod schema');
});

test('Opus 5 has a 1M window, so 25% is achievable without clamping', () => {
  const d = computeWindow('claude-opus-5');
  assert.equal(d.family, 'opus');
  assert.equal(d.modelWindow, 1_000_000);
  assert.equal(d.value, 250_000);
  assert.equal(d.clamped, false);
});

test('GATE 1 — Opus 4.1 at 25% of its 200k window falls BELOW the floor and must clamp + warn', () => {
  const d = computeWindow('claude-opus-4-1');
  assert.equal(d.family, 'opus');
  assert.equal(d.modelWindow, 200_000);
  assert.equal(d.target, 50_000, '25% of 200k');
  assert.ok(d.target < WINDOW_MIN, 'precondition: target is below the hard floor');

  // The whole point: it must NOT be written as-is, because zod .catch(void 0)
  // would silently discard it and revert compaction to auto.
  assert.equal(d.value, WINDOW_MIN);
  assert.equal(d.clamped, true);
  assert.ok(d.warnings.length > 0, 'must warn that the intent could not be met');
  assert.match(d.warnings[0], /SILENTLY DISCARDED/);
  assert.ok(isAcceptable(d.value));
});

test('an observed window beats the fallback table', () => {
  // The table is a guess; the statusline observes the real value. Observed must win —
  // a wrong table entry once nearly caused a 100k install that would have thrashed.
  const d = computeWindow('claude-opus-4-1', { observedWindow: 1_000_000 });
  assert.equal(d.modelWindow, 1_000_000, 'observed overrides the 200k table entry');
  assert.equal(d.value, 250_000);
  assert.equal(d.clamped, false);
  assert.equal(d.windowSource, 'observed');
});

test('never exceeds the model limit or the schema maximum', () => {
  const d = computeWindow('claude-sonnet-5', { observedWindow: 1_000_000, pct: { sonnet: 2.0 } });
  assert.ok(d.value <= WINDOW_MAX);
  assert.ok(d.value <= d.modelWindow);
  assert.equal(d.clamped, true);
  assert.ok(isAcceptable(d.value));
});

test('every family in the default policy yields a schema-valid value', () => {
  for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5', 'some-unknown-model']) {
    const d = computeWindow(model);
    assert.ok(isAcceptable(d.value), `${model} produced ${d.value}`);
  }
});

test('effective window accounts for the 20k output reserve', () => {
  const d = computeWindow('claude-sonnet-5');
  assert.equal(d.effectiveWindow, d.value - 20_000);
});

test('env override is detected and reported', () => {
  assert.equal(envOverride({}), null);
  const o = envOverride({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' });
  assert.equal(o.parsed, 500_000);
  assert.match(o.message, /takes precedence/);
});

test('unknown models fall back to a safe default window', () => {
  assert.equal(resolveWindow('totally-made-up'), 200_000);
});

test('policy percentages match the approved direction (50% sonnet / 25% opus)', () => {
  assert.equal(DEFAULT_PCT.sonnet, 0.50);
  assert.equal(DEFAULT_PCT.opus, 0.25);
});

test('settings.json aliases resolve to the current model, not an unknown 200k default', () => {
  // Regression: settings.model is often "opus"/"sonnet". Treating those as unknown
  // produced a 100k window that would compact every ~42k tokens and thrash.
  const opus = computeWindow('opus');
  assert.equal(opus.modelWindow, 1_000_000);
  assert.equal(opus.value, 250_000);
  assert.equal(opus.clamped, false);

  const sonnet = computeWindow('sonnet');
  assert.equal(sonnet.modelWindow, 1_000_000);
  assert.equal(sonnet.value, 500_000);

  assert.equal(computeWindow('opusplan').value, 250_000);
});
