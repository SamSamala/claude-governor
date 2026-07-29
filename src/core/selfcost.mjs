import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './paths.mjs';
import { loadConfig } from './state.mjs';
import { AGENTS, SKILLS } from './templates.mjs';

/**
 * What Governor itself costs.
 *
 * A tool that criticises others for unfalsifiable savings claims has to publish its own
 * overhead. Measured from the ACTUALLY INSTALLED files where possible, not from the
 * templates, so it reflects reality rather than intent.
 *
 * Two categories, and the distinction is the whole point:
 *   - ALWAYS-ON  : paid on every single request, forever. This is the number that matters.
 *   - CONDITIONAL: paid only when something fires. Bounded, and stated as a worst case.
 */

const tok = (s) => Math.round((s || '').length / 4);

function frontmatterDescription(text) {
  const m = String(text).match(/^description:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

/** Read installed artifacts; fall back to templates when not installed yet. */
function installedDescriptions() {
  const cfgDir = configDir();
  const skills = [];
  const agents = [];

  for (const name of Object.keys(SKILLS)) {
    const p = path.join(cfgDir, 'skills', name, 'SKILL.md');
    let body = SKILLS[name];
    let installed = false;
    try { body = fs.readFileSync(p, 'utf8'); installed = true; } catch { /* template */ }
    skills.push({ name, tokens: tok(frontmatterDescription(body)), installed });
  }

  for (const file of Object.keys(AGENTS)) {
    const p = path.join(cfgDir, 'agents', file);
    let body = AGENTS[file];
    let installed = false;
    try { body = fs.readFileSync(p, 'utf8'); installed = true; } catch { /* template */ }
    agents.push({ name: file.replace(/\.md$/, ''), tokens: tok(frontmatterDescription(body)), installed });
  }

  return { skills, agents };
}

export function selfCost() {
  const cfg = loadConfig();
  const { skills, agents } = installedDescriptions();

  const skillTokens = skills.reduce((a, s) => a + s.tokens, 0);
  const agentTokens = agents.reduce((a, s) => a + s.tokens, 0);

  const alwaysOn = [
    {
      what: 'statusline',
      tokens: 0,
      note: 'rendered in the terminal, never sent to the model',
    },
    {
      what: `${skills.length} skill descriptions`,
      tokens: skillTokens,
      note: 'in the always-on skill listing',
    },
    {
      what: `${agents.length} agent descriptions`,
      tokens: agentTokens,
      note: 'in the subagent roster',
    },
    {
      what: 'hooks (idle)',
      tokens: 0,
      note: 'execute every call but emit nothing unless triggered',
    },
  ];

  const maxAdvisories = cfg.guard?.maxAdvisoriesPerSession ?? 6;
  const conditional = [
    {
      what: 'retrieval advisory',
      tokens: 90,
      cap: `${maxAdvisories}× per session`,
      worst: 90 * maxAdvisories,
      note: 'only when a call is provably unbounded',
    },
    {
      what: '5-hour handoff protocol',
      tokens: 280,
      cap: '1× per 5-hour window',
      worst: 280,
      note: 'latched; never repeats',
    },
    {
      what: 'warm-restart handoff',
      tokens: 2000,
      cap: '1× per session start',
      worst: 2000,
      note: 'replaces replaying a full history — a net saving, counted here anyway',
    },
  ];

  const alwaysOnTotal = alwaysOn.reduce((a, x) => a + x.tokens, 0);
  const conditionalWorst = conditional.reduce((a, x) => a + x.worst, 0);

  return {
    alwaysOn,
    conditional,
    alwaysOnTotal,
    conditionalWorst,
    installed: skills.every((s) => s.installed) && agents.every((a) => a.installed),
    /** Break-even: how many always-on tokens cost vs what one avoided re-read saves. */
    breakEven(requestsPerSession = 64) {
      return alwaysOnTotal * requestsPerSession;
    },
  };
}
