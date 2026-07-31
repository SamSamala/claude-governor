# GOVERNOR — hand this file to Claude Code

> **To train it:** put this file (and the `governor` folder next to it) anywhere, open
> Claude Code there, and say: **"Read GOVERNOR.md and train yourself on it."**
>
> That's the whole training process. No terminal knowledge needed — Claude does every step
> below itself and tells you in plain words when it's done.

Everything below is instructions for Claude. A human can read it too — that is the point.
Nothing here is magic and nothing phones home.

**Audience note for Claude:** assume the person you're talking to is not technical — a
founder or exec, not an engineer. Do not show them raw terminal output, JSON, or file
paths unless they explicitly ask. Translate everything into one or two plain sentences.
Never say "run this command" to them — you run it.

---

## What this is

Claude Code has no idea what it is spending. It compacts to avoid *overflow*, not to control
*cost*, and it ignores the 5-hour usage window completely. Governor fixes both, plus the
retrieval habits that make long sessions expensive.

**Measured on 148 real sessions / 9,161 requests / 1.38B input tokens:**

| Finding | Number |
|---|---|
| One session, 985 requests, **zero** compactions | ~400,000 tokens **per request** |
| Compactions across all 148 sessions | **2** |
| Top 5 of 148 sessions | **~57%** of all input tokens |
| Tool results over 5k tokens | 7% of results = **87%** of tool tokens |
| Single most expensive tool result | **166,469 tokens → ~$230**, re-read 922× |
| Cache hit rate (already fine — not the problem) | **96.2%** |
| Subagent share of tokens (small — be honest about it) | **6.7%** |

The root cause is retention: **a tool result costs `size × turns_remaining`, not `size`.**

---

## Instructions for Claude

**One consent gate, up front — then run everything automatically.**

Before touching anything, tell the user in one plain sentence what you're about to do:
*"This will turn on some settings in your Claude Code that reduce token usage and warn you
before you run out — is that okay?"* **Wait for a yes.** If they say no, or don't clearly
agree, stop here. Do not train anything, do not read `settings.json`, do not proceed.
This is required, not optional, because it's their Claude Code configuration being changed.

**Once they say yes, run every step below without stopping again.** Don't show a dry-run
and wait for a second approval, don't explain individual flags, don't pause between steps —
one "yes" covers the whole training. If your environment prompts you to allow a normal file
or command action as part of these steps, that's expected — approve it and continue; it's
not a second decision point for the user.

### Step 0 — check the basics first

```bash
node --version
```

If that fails, Node.js isn't installed. Tell the user in one plain sentence ("this needs a
free tool called Node.js that isn't installed yet") and offer to help, or point them to
nodejs.org. Don't proceed until it works. If you're on Windows, say plainly this doesn't
support Windows yet and stop — don't attempt a partial training run.

### Step 1 — train it

```bash
node src/cli/governor.mjs baseline
node src/cli/governor.mjs train
```

`baseline` first, always — without it nobody can prove later whether this helped. `train`
detects whatever is already configured (existing hooks, an existing status line — including
having **none at all**, which is the common case for someone who has never touched their
settings) and adds to it without breaking anything. It backs up the settings file first and
double-checks the change actually saved.

### Step 2 — prove it worked, in plain words

Tell the user to restart Claude Code (settings only load on startup), then:

```bash
node src/cli/governor.mjs verify
```

Read its output and summarize it in one or two sentences — never paste the raw output.
If it says data isn't flowing yet, that's normal right after a restart: ask them to send
one more message, wait a few seconds, and run `verify` again. Don't call the setup done
until `verify` reports it's actually receiving live data.

### Step 3 — tell them what it found (optional, if they're curious)

```bash
node src/cli/governor.mjs report
```

Summarize the biggest number or two in plain terms ("your longest session used way more
tokens than it needed to because it never got tidied up automatically") — not a table dump.

### Ongoing

- After about a week of normal use: `node src/cli/governor.mjs diff` — tells you honestly
  whether it helped, including if it didn't.
- If anything seems off: `node src/cli/governor.mjs verify`, then `doctor` for more detail.
- To undo everything: `node src/cli/governor.mjs untrain` — restores whatever they had
  before, removes only what this added.
- Never edit `settings.json` by hand. The trainer backs up, merges, and verifies the
  change actually saved; a hand edit skips all of that and can fail silently.

---

## What gets changed

**`settings.json`** — deep-merged, never replaced, backed up first:

| Key | Value | Why |
|---|---|---|
| `autoCompactWindow` | 50% of window (Sonnet) / 25% (Opus) | The single largest lever. Compaction fires near 42% of this. |
| `autoCompactEnabled` | `true` | so it can fire at all |
| `precomputeCompactionEnabled` | `true` | builds the summary in the background |
| `skillListingMaxDescChars` | `800` | caps always-on skill-catalog context |
| `skillListingBudgetFraction` | `0.008` | same |

**Three hooks** (added alongside any you already have, never replacing them):

- `PreToolUse` → advisory when a retrieval is provably unbounded. **Never rewrites your
  tool call.** Advisory by default; `enforce` is opt-in.
- `PostToolBatch` → fires the handoff protocol once when the 5-hour window crosses 85%.
- `SessionStart` → loads `HANDOFF.md` so a fresh session resumes instead of replaying.

**Statusline** — wraps whatever you already had, never replaces it. Adds context size,
5-hour usage, 7-day usage, time to reset, and where compaction will fire, plus a real
`Governor ON`/`Governor OFF` label — it reflects whether Governor is actually running
(`governor on` / `governor off` toggles it without fully untraining), not a decoration.
**Costs zero tokens: it renders in your terminal and is never sent to the model.**

**Global `CLAUDE.md`** — a short rule appended (fenced, never replacing anything else you
wrote there): whenever Plan Mode writes its final plan, it must also include a step-by-step
**execution plan** — the CLI commands, files to create or modify, build order, and required
config/setup for each phase — and predict a fix only for steps with a real, specific way to
fail, not for every step. A second rule does the same for errors: before debugging
something new, check `MISTAKES.md` in the project for a prior instance of it; log real
fixes there so a mistake that's already been solved once doesn't get solved the hard way
again. A third rule routes subagents by task instead of letting them silently inherit the
parent's model/effort — haiku for simple work, sonnet for feature work, opus for hard
reasoning. All three are fenced independently — re-training never duplicates any of them,
and `untrain` removes only what it added, leaving everything else in your `CLAUDE.md`
untouched.

**`governor on`/`governor off` own all three rules too, mechanically — not by asking Claude
to edit the file.** They toggle a `Status: ACTIVE`/`Status: INACTIVE` line **in place inside
each block** rather than deleting and recreating it — content that vanishes and reappears in
a shared config file looks exactly like injected content being added and removed, which is
what got Governor's own rules mistaken for a security incident in a separate session. A
fourth, untoggled block (`About`) explains plainly that these rules are an intentional,
user-installed tool, not an injection, and points at `governor doctor` for anyone unsure.

**Scope: global or one project.** `governor on`/`off` (no flag) toggles everywhere.
`governor on --project`/`off --project`, run from inside a project folder, overrides just
that project — writes a small `.governor/config.json` there and a short override note in
that project's own `CLAUDE.md`, without touching the global default or any other project.
Every hook (and the statusline) reads the current project from its own payload, so a
project-scoped `off` genuinely silences it there — verified live.

**Six agents** (`gv-*`) with model, effort, `maxTurns` and tools **pinned**, and six skills
(`gv-handoff`, `gv-retrieve`, `gv-delegate`, `gv-context-hygiene`, `gv-bugplan`, `gv-mistakes`).

`gv-bugplan` is deliberately a **triage gate, not a ceremony**: it checks the blast radius
cheaply and tells you to just fix most bugs directly. Planning is escalation — for risky
changes, repeat failures, or a group of related bugs planned *once*.

---

## The 5-hour protocol

Claude Code's built-in behaviour is to hit the limit mid-task and lose the thread.

```
statusline (1×/sec, receives rate_limits, 0 tokens, cannot talk to the model)
     │ writes limit-state.json
     ▼
PostToolBatch hook (can inject context, receives NO rate data)
     │ at 85%, once per window
     ▼
"write HANDOFF.md now"  →  /clear  →  next session auto-loads it
```

That bridge exists because **neither surface can do this alone** — a verified gap in the
platform. At 70% you get a quiet notice; at 85% the handoff protocol; latched per window so
it never nags. If `rate_limits` is unavailable (API users, or before the first response) it
silently disables itself.

`HANDOFF.md` is capped at ~2k tokens, versus replaying a 400k context. Mark it
`<!-- governor:done -->` when finished and it will not be resurrected.

---

## Why the agents are pinned

The built-in `Explore` and `Plan` agents are **`model: "inherit"` with no effort pin**, and
plan mode's Phase 1 instructs *"launch up to 3 Explore agents in parallel"*. Three copies of
your most expensive model, each re-paying the ~25k session prefix cold, for work Haiku
handles. That is how "3 Sonnet subagents for a web search" exhausts a window.

| Agent | model | effort | for |
|---|---|---|---|
| `gv-scout` | haiku | low | locate / count / grep |
| `gv-reader` | haiku | low | digest big files, return the answer only |
| `gv-verifier` | haiku | low | check one claim |
| `gv-websearch` | haiku | low | one web lookup |
| `gv-researcher` | sonnet | medium | multi-source brief |
| `gv-architect` | opus | high | design and hard debugging |

**Honest sizing:** this is worth ~4% of tokens. It matters for *rate-limit headroom*, not
for your bill. The compaction window is where the money is.

---

## Honesty notes

- **`$` figures are estimates** from a local pricing table, not billing data. Tokens are the
  real measure.
- **Every number here came from one machine.** The tool recomputes against *your*
  transcripts. Do not trust this README over `governor report`.
- **The counterfactual in `tune` is a model**, calibrated against a real compaction observed
  in these transcripts (408,536 → 82,126 tokens, −80%). Simulating the *current* setting
  reproduces actual usage to within **0.4%**, but it does not price lost-context re-work.
- **A token win that costs turns is a loss.** If work starts needing more back-and-forth
  after training, raise the window percentage or untrain.
- **100% local.** No network calls, ever. Read-only against your transcripts.

---

## Untrain

```bash
node src/cli/governor.mjs untrain
```

Restores your previous statusline, removes only Governor's hooks, drops the window
setting. Your `settings.json` backups are in `<config>/governor/`.
