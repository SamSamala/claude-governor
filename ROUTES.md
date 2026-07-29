# Route map

Generated mechanically by Governor — no model read your files, so this cost ~0 tokens.
**Read this before searching the codebase.** Entries marked `STALE` changed since the
last scan; re-run `governor routes .` to refresh. Blast radius: `governor impact <file>`.

27 files.

## src/cli

- `governor.mjs` (545L) — — **STALE**

## src/core

- `analyze.mjs` (174L) — analyzeSession, analyzeAll, retentionOffenders, BIG_RESULT_TOKENS, familyOf _(←2)_
- `claudemd.mjs` (92L) — upsertBlock, removeBlock, hasBlock, PLAN_MODE_ID, PLAN_MODE_BLOCK _(←2)_
- `install.mjs` (282L) — probe, install, uninstall _(←1)_
- `parse.mjs` (106L) — readRecords, usageOf, contextTokens, isSubagent, blocksOf, estimateTokens, isCompactBoundary _(←2)_
- `paths.mjs` (47L) — configDir, projectsDir, governorDir, settingsPath, findTranscripts _(←4)_
- `policy.mjs` (152L) — WINDOW_MIN, WINDOW_MAX, OUTPUT_RESERVE, DEFAULT_PCT, KNOWN_WINDOWS, ALIASES, canonicalModel, resolveWindow, computeWindow, isAcceptable _(←4)_
- `price.mjs` (74L) — PRICING, CACHE_READ_MULT, CACHE_WRITE_5M_MULT, CACHE_WRITE_1H_MULT, familyOf, rates, costOf, retentionCost, fmtUSD, fmtTok _(←3)_
- `proof.mjs` (104L) — BASELINE, metricsFor, saveBaseline, loadBaseline, compare _(←2)_
- `selfcost.mjs` (121L) — selfCost
- `sim.mjs` (69L) — OBSERVED_TRIGGER_FRACTION, OBSERVED_RESET_FRACTION, deltasOf, simulateSession, simulateAll, actualTotal _(←1)_
- `state.mjs` (152L) — CONFIG, limitStateFile, readLimitState, writeLimitState, pruneLimitStates, countLimitStates, listLimitStates, DEFAULT_CONFIG, readJSON, writeJSON _(←8)_
- `templates.mjs` (284L) — AGENTS, SKILLS _(←2)_

## src/routes

- `impact.mjs` (101L) — resolveEntry, downstream, upstream, impactOf _(←2)_
- `refresh.mjs` (68L) — INDEX_FILE, loadIndex, saveIndex, diffIndex, refresh _(←2)_
- `scan.mjs` (251L) — listSourceFiles, extract, hashOf, scanRepo, ROOT_BUDGET_BYTES, renderRouteFiles, renderRoutes _(←2)_

## src/runtime

- `guard.mjs` (121L) — —
- `limit-guard.mjs` (111L) — —
- `session-start.mjs` (93L) — —
- `statusline.mjs` (215L) — — **STALE**

## test

- `claudemd.test.mjs` (80L) — —
- `install.test.mjs` (223L) — — **STALE**
- `parse.test.mjs` (107L) — —
- `policy.test.mjs` (102L) — —
- `proof.test.mjs` (75L) — —
- `routes.test.mjs` (132L) — —
- `runtime.test.mjs` (376L) — — **STALE**
