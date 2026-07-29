# Governor

**Trains your Claude Code to stop running out of steam mid-project.**

If you use Claude Code, you've had this happen: you're deep into something, everything's
going well, and then Claude suddenly forgets what you were doing — or you hit a usage limit
with no warning and have to start over. That's wasted time, wasted money, and a broken train
of thought.

Governor fixes that. It's a one-time training — you tell your Claude Code to read this repo
and train itself, say yes to one simple question, and it's done. From then on it just runs:

- **Warns you before you run out**, instead of cutting you off mid-task with no notice.
- **Keeps sessions running longer** by managing memory smarter, so you get more done before
  a reset.
- **Remembers where you left off** after a reset, so you don't re-explain your whole project.
- **Shows you it's actually working** — a live `Governor ON` indicator, not a promise.

## How to train your Claude Code

1. Put this folder anywhere on your computer.
2. Open Claude Code inside it.
3. Say: **"Read GOVERNOR.md and train yourself on it."**

That's it. Claude Code reads the instructions and trains itself — no terminal commands for
you to run, no config files to touch. It'll ask you one plain yes/no question first, then
do the rest on its own and tell you in plain words when it's done.

## How to use it

Once trained, it runs on its own in the background — you don't do anything differently.
A few commands if you're curious:

```bash
governor verify   # is it actually working right now, in plain English
governor report    # where your tokens have actually been going
governor diff       # after a week — did it really help?
governor on/off      # pause or resume any time, no need to fully untrain
governor untrain      # remove everything, restores exactly what you had before
```

**Handing it to someone else?** Point them at [`GOVERNOR.md`](./GOVERNOR.md) — it's written
so their Claude Code can read it and train itself the same way.

## Why

Measured across 148 real sessions / 9,161 requests / 1.38B input tokens:

- One session ran **985 requests at ~400,000 tokens each with zero compactions**.
- **2 compactions** across all 148 sessions — the default window is so high it never fires.
- **7% of tool results carry 87% of all tool tokens.**
- The worst single result: **166,469 tokens ≈ $230**, because it landed at turn 63 of 985
  and was re-read **922 times**.

A tool result costs **`size × turns_remaining`**, not `size`. That is the whole thesis.

## What it does

| Component | Effect | Cost to run |
|---|---|---|
| Compaction window policy | 50% of window (Sonnet) / 25% (Opus) — the big lever | 0 tokens (a setting) |
| 5-hour protocol | at 85%, writes a handoff so you can `/clear` safely | 0 until it fires |
| Warm restart | next session loads `HANDOFF.md` instead of replaying history | ~2k tokens |
| Statusline | live context, 5h usage, reset time, compaction point | **0 tokens** — terminal only |
| Admission guard | advises when a retrieval is provably unbounded; never rewrites it | ~0 |
| Route map | `ROUTES.md` so Claude stops re-reading the repo | 0 — built mechanically |
| Agent roster | model + effort + maxTurns pinned (built-ins are `model: "inherit"`) | 0 |
| Bug triage | most bugs get fixed directly; only risky ones get a plan | ~0 |

## Commands

```
report      where your tokens went, with retention attribution
tune        measured savings per window size, from your own transcripts
gate0       observed compactions — does compaction fire, and where
train       train your Claude Code — apply everything (--dry-run to preview)
untrain     restore your previous statusline, remove only our hooks
doctor      probe capabilities and show current state
routes DIR  build ROUTES.md
impact FILE blast radius: what a change here can break
audit       what you pay for on every single request
baseline    snapshot today's cost, before training
diff        compare against the baseline — reports regressions honestly
```

## Proving it works

```bash
governor baseline     # before training
governor train
# ...use Claude Code normally for a week...
governor diff
```

`diff` tracks **turns-to-completion as well as tokens**. If context resets start costing
extra back-and-forth, it reports `REGRESSION` rather than claiming a token win. It refuses
to draw a conclusion from fewer than 3 post-baseline sessions.

## Honesty

- `$` figures are **estimates** from a local pricing table, not billing data.
- Every number here is from **one machine**. Run `report` — trust yours over ours.
- The `tune` counterfactual is calibrated against a real observed compaction
  (408,536 → 82,126 tokens) and reproduces current usage to within **0.4%** — but it does
  not price lost-context re-work.
- **A token win that costs turns is a loss.** If work needs more back-and-forth after
  training, raise the percentage or untrain.
- Subagent routing is worth **~4%** of tokens. It matters for rate-limit headroom, not your
  bill. The window is where the money is.

## Requirements

Node ≥ 18, macOS or Linux. Respects `CLAUDE_CONFIG_DIR`.

```bash
npm test    # 86 tests
```

MIT.
