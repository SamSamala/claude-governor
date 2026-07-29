import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Route map — a compact index so Claude can find the right file without reading the repo.
 *
 * Generation is MECHANICAL by design. Having a model read every file to summarise it
 * costs exactly the tokens the map is supposed to save, so we extract structure with
 * parsers and never call an LLM here.
 *
 * Staleness is the killer failure: a map that confidently points at a moved file is
 * worse than no map. Every entry carries a content hash and is re-derived when it moves.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.next',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo', '.svelte-kit',
  'Pods', 'DerivedData', '.gradle', '.idea', '.vscode', 'tmp', '.pytest_cache',
]);

const EXT_LANG = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'py', '.go': 'go', '.rs': 'rs', '.rb': 'rb',
  '.java': 'java', '.kt': 'kt', '.swift': 'swift',
  '.php': 'php', '.sh': 'sh', '.bash': 'sh',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
};

const MAX_FILE_BYTES = 400_000; // don't try to parse generated blobs

export function listSourceFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude') {
        if (e.isDirectory()) continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (EXT_LANG[ext]) out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root, 0);
  return out;
}

const RE = {
  // `function\*?` matters: generators (`export async function* readRecords`) are otherwise missed.
  jsExport: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s*([A-Za-z_$][\w$]*)/gm,
  jsExportList: /^\s*export\s*\{([^}]+)\}/gm,
  jsImport: /^\s*import\s+(?:[\w*\s{},$]+\s+from\s+)?['"]([^'"]+)['"]/gm,
  jsRequire: /require\(\s*['"]([^'"]+)['"]\s*\)/gm,
  pyDef: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  pyClass: /^class\s+([A-Za-z_]\w*)/gm,
  pyImport: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm,
  goFunc: /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm,
  goImport: /^\s*"([^"]+)"\s*$/gm,
  rsPub: /^\s*pub\s+(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/gm,
  generic: /^\s*(?:public\s+|pub\s+)?(?:function|func|def|class|struct|interface|type)\s+([A-Za-z_]\w*)/gm,
};

function collect(re, text, group = 1, cap = 12) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null && out.length < cap) {
    const v = m[group] ?? m[2];
    if (v) out.push(v.trim());
  }
  return out;
}

export function extract(file, text, lang) {
  let symbols = [];
  let imports = [];

  if (lang === 'ts' || lang === 'js') {
    symbols = collect(RE.jsExport, text);
    for (const grp of collect(RE.jsExportList, text, 1, 6)) {
      for (const part of grp.split(',')) {
        const name = part.split(/\s+as\s+/i)[0].trim();
        if (name && symbols.length < 12) symbols.push(name);
      }
    }
    imports = [...collect(RE.jsImport, text, 1, 20), ...collect(RE.jsRequire, text, 1, 10)];
  } else if (lang === 'py') {
    symbols = [...collect(RE.pyClass, text, 1, 6), ...collect(RE.pyDef, text, 1, 8)];
    imports = collect(RE.pyImport, text, 1, 15);
  } else if (lang === 'go') {
    symbols = collect(RE.goFunc, text);
    imports = collect(RE.goImport, text, 1, 15);
  } else if (lang === 'rs') {
    symbols = collect(RE.rsPub, text);
  } else {
    symbols = collect(RE.generic, text);
  }

  return {
    symbols: [...new Set(symbols)].slice(0, 10),
    imports: [...new Set(imports.filter((i) => i.startsWith('.')))].slice(0, 10),
  };
}

export function hashOf(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** Scan a repo into an index. Purely mechanical; no model involved. */
export function scanRepo(root) {
  const files = listSourceFiles(root);
  const entries = [];
  for (const f of files) {
    let text = '';
    try {
      const st = fs.statSync(f);
      if (st.size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(f, 'utf8');
    } catch { continue; }

    const rel = path.relative(root, f);
    const lang = EXT_LANG[path.extname(f)] || 'txt';
    const { symbols, imports } = extract(f, text, lang);
    entries.push({
      path: rel,
      lang,
      lines: text.split('\n').length,
      hash: hashOf(text),
      symbols,
      imports,
      note: null, // optional one-liner; only ever filled by a cheap model, never the main one
    });
  }

  // Reverse dependency edges: who imports this file.
  const byNoExt = new Map();
  for (const e of entries) byNoExt.set(e.path.replace(/\.[^.]+$/, ''), e.path);
  const importedBy = new Map();
  for (const e of entries) {
    for (const imp of e.imports) {
      const resolved = path.normalize(path.join(path.dirname(e.path), imp)).replace(/\.[^.]+$/, '');
      const target = byNoExt.get(resolved) || byNoExt.get(path.join(resolved, 'index'));
      if (!target) continue;
      if (!importedBy.has(target)) importedBy.set(target, []);
      importedBy.get(target).push(e.path);
    }
  }
  for (const e of entries) e.importedBy = (importedBy.get(e.path) || []).slice(0, 8);

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { root, generatedAt: Date.now(), entries };
}

/**
 * Root map must stay cheap enough to read every session.
 * Measured: ~115 bytes/file, so a flat map costs ~29k tokens at 1,000 files — worse than
 * the re-reading it replaces. Above this budget we switch to a two-tier layout.
 */
export const ROOT_BUDGET_BYTES = 12_000; // ~3k tokens

function groupByDir(entries) {
  const byDir = new Map();
  for (const e of entries) {
    const d = path.dirname(e.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(e);
  }
  return byDir;
}

function fileLine(e, withDir = false) {
  const syms = e.symbols.length ? e.symbols.join(', ') : '—';
  const used = e.importedBy?.length ? ` _(←${e.importedBy.length})_` : '';
  const stale = e.stale ? ' **STALE**' : '';
  const note = e.note ? ` — ${e.note}` : '';
  const name = withDir ? e.path : path.basename(e.path);
  return `- \`${name}\` (${e.lines}L) — ${syms}${used}${stale}${note}`;
}

const HEADER = [
  `Generated mechanically by Governor — no model read your files, so this cost ~0 tokens.`,
  `**Read this before searching the codebase.** Entries marked \`STALE\` changed since the`,
  `last scan; re-run \`governor routes .\` to refresh. Blast radius: \`governor impact <file>\`.`,
];

/** Flat map: one section per directory, one line per file. Used for small/medium repos. */
function renderFlat(index) {
  const lines = [`# Route map`, ``, ...HEADER, ``, `${index.entries.length} files.`, ``];
  for (const [dir, files] of [...groupByDir(index.entries).entries()].sort()) {
    lines.push(`## ${dir === '.' ? '(root)' : dir}`, '');
    for (const e of files) lines.push(fileLine(e));
    lines.push('');
  }
  return lines.join('\n');
}

/** Tier 1: directory index only. Detail moves into per-directory ROUTES.md files. */
function renderIndexOnly(index) {
  const byDir = [...groupByDir(index.entries).entries()].sort();
  const lines = [
    `# Route map — index`, ``, ...HEADER, ``,
    `${index.entries.length} files across ${byDir.length} directories. This repo is large, so`,
    `detail lives in a \`ROUTES.md\` inside each directory. **Read only the ones you need.**`,
    ``,
    `| directory | files | detail |`,
    `|---|---|---|`,
  ];
  for (const [dir, files] of byDir) {
    const stale = files.some((f) => f.stale) ? ' ⚠' : '';
    lines.push(`| \`${dir === '.' ? '(root)' : dir}\` | ${files.length}${stale} | \`${path.join(dir, 'ROUTES.md')}\` |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderDir(dir, files) {
  const lines = [`# ${dir === '.' ? '(root)' : dir}`, ``, ...HEADER, ``];
  for (const e of files) lines.push(fileLine(e));
  lines.push('');
  return lines.join('\n');
}

/**
 * Returns every file to write. Picks flat or two-tier based on the measured budget, so a
 * large repo never turns the map into the very cost it was meant to remove.
 */
export function renderRouteFiles(index) {
  const flat = renderFlat(index);
  if (Buffer.byteLength(flat) <= ROOT_BUDGET_BYTES) {
    return { tiered: false, files: [{ path: 'ROUTES.md', content: flat }] };
  }
  const files = [{ path: 'ROUTES.md', content: renderIndexOnly(index) }];
  for (const [dir, entries] of groupByDir(index.entries)) {
    files.push({ path: path.join(dir, 'ROUTES.md'), content: renderDir(dir, entries) });
  }
  return { tiered: true, files };
}

/** Back-compat: the flat rendering. */
export function renderRoutes(index) {
  return renderFlat(index);
}
