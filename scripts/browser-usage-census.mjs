#!/usr/bin/env node
// Browser usage census (#392, spec #388 success metric): how many REAL `tool_use` blocks agents issued
// against each browser surface, read from the Claude Code transcripts. Read-only: it never writes.
//
//   node scripts/browser-usage-census.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//        [--root <projects-dir>]... [--format json|table|both]   (default both: JSON on stdout, table on stderr)
//
// Surfaces: chrome-main (mcp__chrome-main__*), chrome-devtools (mcp__chrome-devtools__*), panel-mcp
// (mcp__browser__*), orchestra-browser-cli (a Bash tool_use whose command RUNS `orchestra browser`).
// Counted: `tool_use` content blocks of `assistant` records, de-duplicated by tool_use id. NOT counted: tool
// listings (attachment / system / tool_result lines), prose mentioning a tool name, `api-request-blob` replays of a
// request, and `orchestra browser` appearing inside a quoted string or heredoc. One Bash block = one call even if
// it chains several CLI invocations (the spec's unit is the tool_use block). Window: UTC days, both bounds inclusive.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SURFACES = [
  { key: 'chrome-main', label: 'chrome-main', prefix: 'mcp__chrome-main__' },
  { key: 'chrome-devtools', label: 'chrome-devtools', prefix: 'mcp__chrome-devtools__' },
  { key: 'panel-mcp', label: 'panel MCP (mcp__browser__*)', prefix: 'mcp__browser__' },
  { key: 'orchestra-browser-cli', label: 'orchestra browser CLI', prefix: null },
];

/** Replace string literals with placeholders and drop heredoc bodies, so only text that EXECUTES is left;
 *  `$(…)`, backticks and `sh -c '…'` payloads are scanned recursively and appended as their own commands. */
export function shellSkeleton(cmd, depth = 0) {
  const SH_C = /(?:^|[\s;&|(])(?:ba|z|da|k|a)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+$/;
  const n = cmd.length;
  const pending = [];
  let out = '';
  let i = 0;
  const closeParen = (from) => {
    let d = 1;
    for (let j = from; j < n; j++) {
      if (cmd[j] === '(') d++;
      else if (cmd[j] === ')' && --d === 0) return j;
    }
    return n;
  };
  while (i < n) {
    const ch = cmd[i];
    if (ch === '\n' && pending.length) {
      out += '\n';
      i++;
      for (const h of pending.splice(0)) {
        while (i < n) {
          let e = cmd.indexOf('\n', i);
          if (e < 0) e = n;
          const line = cmd.slice(i, e);
          i = Math.min(e + 1, n);
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.word) break;
        }
      }
      continue;
    }
    if (ch === '\\') {
      const nx = cmd[i + 1] ?? '';
      out += nx === '\n' ? ' ' : /["'`$]/.test(nx) ? '_' : nx;
      i += 2;
    } else if (ch === "'") {
      let e = cmd.indexOf("'", i + 1);
      if (e < 0) e = n;
      const body = cmd.slice(i + 1, e);
      out += depth < 3 && SH_C.test(out) ? ` ; ${shellSkeleton(body, depth + 1)} ; ` : "''";
      i = e + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let body = '';
      const subs = [];
      while (j < n && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < n) {
          body += /["\\$`]/.test(cmd[j + 1]) ? cmd[j + 1] : cmd[j] + cmd[j + 1];
          j += 2;
        } else if (cmd[j] === '$' && cmd[j + 1] === '(') {
          const e = closeParen(j + 2);
          subs.push(cmd.slice(j + 2, e));
          body += cmd.slice(j, e + 1);
          j = e + 1;
        } else if (cmd[j] === '`') {
          let e = cmd.indexOf('`', j + 1);
          if (e < 0) e = n;
          subs.push(cmd.slice(j + 1, e));
          body += cmd.slice(j, e + 1);
          j = e + 1;
        } else body += cmd[j++];
      }
      if (depth < 3 && SH_C.test(out)) out += ` ; ${shellSkeleton(body, depth + 1)} ; `;
      else out += '""' + (depth < 3 ? subs.map((s) => ` ; ${shellSkeleton(s, depth + 1)} ; `).join('') : '');
      i = j + 1;
    } else if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<(-?)\s*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_]\w*))/.exec(cmd.slice(i));
      if (m) {
        pending.push({ dash: m[1] === '-', word: m[2] ?? m[3] ?? m[4] });
        out += '<<';
        i += m[0].length;
      } else {
        out += ch;
        i++;
      }
    } else if (ch === '#' && (out === '' || /[\s;&|(]$/.test(out))) {
      while (i < n && cmd[i] !== '\n') i++; // a shell comment: nothing in it runs
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Command wrappers the CLI is often run through: the options that take a value, and how many bare positionals precede the command.
const WRAPPERS = {
  sudo: { opts: 'ugCDhprtUT', pos: 0 }, env: { opts: 'uCS', pos: 0 }, nice: { opts: 'n', pos: 0 }, ionice: { opts: 'cnp', pos: 0 },
  time: { opts: 'fo', pos: 0 }, exec: { opts: 'a', pos: 0 }, nohup: { opts: '', pos: 0 }, setsid: { opts: '', pos: 0 },
  timeout: { opts: 'sk', pos: 1 }, stdbuf: { opts: 'ioe', pos: 0 }, flock: { opts: 'wEc', pos: 1 }, xargs: { opts: 'IniPdaEsL', pos: 0 },
};
const LEADING_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!']);
const ENV_ASSIGN = /^[A-Za-z_]\w*=/;
const IS_ORCHESTRA = /(?:^|\/)orchestra$/;

/** The tool name for ONE simple command's tokens when it runs `orchestra browser [sub]`, else null. Linear: no regex backtracking. */
function segmentInvocation(tokens) {
  let i = 0;
  const skipAssigns = () => { while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) i++; };
  while (i < tokens.length && LEADING_KEYWORDS.has(tokens[i])) i++;
  for (;;) {
    skipAssigns();
    const w = WRAPPERS[tokens[i]];
    if (!w) break;
    i++;
    let pos = w.pos;
    for (; i < tokens.length; ) {
      const t = tokens[i];
      if (IS_ORCHESTRA.test(t)) break;
      if (t.length > 1 && t[0] === '-') i += t.length === 2 && w.opts.includes(t[1]) ? 2 : 1;
      else if (ENV_ASSIGN.test(t)) i++;
      else if (pos > 0 && !WRAPPERS[t]) { i++; pos--; }
      else break;
    }
  }
  if (!IS_ORCHESTRA.test(tokens[i] ?? '') || tokens[i + 1] !== 'browser') return null;
  const sub = tokens[i + 2];
  return `orchestra browser${sub && /^[A-Za-z][\w-]*$/.test(sub) ? ` ${sub}` : ''}`;
}

/** The `orchestra browser <sub>` tool name when the Bash command RUNS the CLI, else null. */
export function orchestraBrowserInvocation(command) {
  if (typeof command !== 'string' || !command.includes('browser')) return null;
  for (const seg of shellSkeleton(command).split(/\$\(|[;&|\n(){}`]/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const hit = segmentInvocation(tokens);
    if (hit) return hit;
  }
  return null;
}

/** { surface, tool } for one `tool_use` block, or null when it is not a browser call. */
export function classifyToolUse(block) {
  if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') return null;
  for (const s of SURFACES) if (s.prefix && block.name.startsWith(s.prefix)) return { surface: s.key, tool: block.name };
  if (block.name === 'Bash') {
    const tool = orchestraBrowserInvocation(block.input?.command);
    if (tool) return { surface: 'orchestra-browser-cli', tool };
  }
  return null;
}

/** The tool_use blocks a record really ISSUED: an assistant record's content. Listings, tool_results, prose and
 *  api-request-blob replays are not calls. */
export function toolUseBlocks(record) {
  if (!record || record.type !== 'assistant' || !Array.isArray(record.message?.content)) return [];
  return record.message.content.filter((b) => b && b.type === 'tool_use');
}

export function createCensus() {
  const surfaces = {};
  for (const s of SURFACES) surfaces[s.key] = { calls: 0, sessions: new Set(), tools: {}, firstTs: null, lastTs: null };
  return { surfaces, seenIds: new Set(), scanned: { files: 0, lines: 0, toolUseBlocks: 0, duplicatesSkipped: 0, outsideWindow: 0, undatedExcluded: 0, unparsableLines: 0, unreadableFiles: 0 } };
}

/** Parse --since / --until (YYYY-MM-DD, UTC, inclusive) into epoch-ms bounds; throws on garbage. */
export function parseWindow(since, until) {
  const day = (v, name) => {
    if (v == null) return null;
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) throw new Error(`${name} must be a real YYYY-MM-DD date, got "${v}"`);
    return ms;
  };
  const lo = day(since, '--since');
  const hi = day(until, '--until');
  if (lo != null && hi != null && lo > hi) throw new Error('--since is after --until');
  return { since: since ?? null, until: until ?? null, loMs: lo, hiMs: hi == null ? null : hi + 86_400_000 };
}

/** Add one parsed record to the census. `sessionFallback` names the session when the record carries no sessionId. */
export function addRecord(census, record, window, sessionFallback) {
  const blocks = toolUseBlocks(record);
  for (const block of blocks) {
    const hit = classifyToolUse(block);
    if (!hit) continue;
    census.scanned.toolUseBlocks++;
    const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (window.loMs != null || window.hiMs != null) {
      if (Number.isNaN(ts)) { census.scanned.undatedExcluded++; continue; }
      if ((window.loMs != null && ts < window.loMs) || (window.hiMs != null && ts >= window.hiMs)) { census.scanned.outsideWindow++; continue; }
    }
    if (block.id != null) {
      if (census.seenIds.has(block.id)) { census.scanned.duplicatesSkipped++; continue; }
      census.seenIds.add(block.id);
    }
    const s = census.surfaces[hit.surface];
    s.calls++;
    s.tools[hit.tool] = (s.tools[hit.tool] ?? 0) + 1;
    s.sessions.add(record.sessionId ?? record.session_id ?? sessionFallback);
    if (!Number.isNaN(ts)) {
      const iso = new Date(ts).toISOString();
      if (s.firstTs == null || iso < s.firstTs) s.firstTs = iso;
      if (s.lastTs == null || iso > s.lastTs) s.lastTs = iso;
    }
  }
}

/** Feed one transcript file's text (JSONL) to the census. */
export function addTranscriptText(census, text, window, sessionFallback) {
  census.scanned.files++;
  let pos = 0;
  while (pos < text.length) {
    let e = text.indexOf('\n', pos);
    if (e < 0) e = text.length;
    const line = text.slice(pos, e);
    pos = e + 1;
    if (!line) continue;
    census.scanned.lines++;
    if (!line.includes('tool_use')) continue; // cheap prefilter: a call line always carries the literal block type
    let record;
    try { record = JSON.parse(line); } catch { census.scanned.unparsableLines++; continue; }
    addRecord(census, record, window, sessionFallback);
  }
}

export function finalize(census, { window, roots }) {
  const surfaces = {};
  for (const s of SURFACES) {
    const c = census.surfaces[s.key];
    surfaces[s.key] = { calls: c.calls, sessions: c.sessions.size, firstTs: c.firstTs, lastTs: c.lastTs, tools: Object.fromEntries(Object.entries(c.tools).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) };
  }
  const human = surfaces['chrome-main'].calls + surfaces['chrome-devtools'].calls;
  const panel = surfaces['panel-mcp'].calls + surfaces['orchestra-browser-cli'].calls;
  return {
    generatedAt: new Date().toISOString(),
    window: { since: window.since, until: window.until, tz: 'UTC' },
    roots,
    scanned: census.scanned,
    surfaces,
    totals: { humanChrome: human, panel, panelShare: human + panel === 0 ? null : Number((panel / (human + panel)).toFixed(4)) },
  };
}

export function renderTable(report) {
  const rows = [['surface', 'calls', 'sessions', 'first', 'last']];
  for (const s of SURFACES) {
    const r = report.surfaces[s.key];
    rows.push([s.label, String(r.calls), String(r.sessions), r.firstTs?.slice(0, 10) ?? '-', r.lastTs?.slice(0, 10) ?? '-']);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  const share = report.totals.panelShare == null ? 'n/a' : `${(report.totals.panelShare * 100).toFixed(1)}%`;
  const win = report.window.since || report.window.until ? `${report.window.since ?? '…'} → ${report.window.until ?? '…'} (UTC)` : 'all time';
  return [`browser tool_use census — ${win}`, fmt(rows[0]), ...rows.slice(1).map(fmt), `human Chrome (main+devtools) ${report.totals.humanChrome} · panel (mcp+cli) ${report.totals.panel} · panel share ${share}`].join('\n');
}

/** Every `.jsonl` under `dir`, sorted; symlinked files/dirs are followed once (a directory seen by realpath is not re-entered). */
export function* walkJsonl(dir, seen = new Set()) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return; }
  if (seen.has(real)) return;
  seen.add(real);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st = e;
    if (e.isSymbolicLink()) { try { st = fs.statSync(p); } catch { continue; } }
    if (st.isDirectory()) yield* walkJsonl(p, seen);
    else if (st.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

/** The `projects/` dir of every `~/.claude*` config dir (de-duplicated by realpath so a symlinked one is read once). */
export function defaultRoots(home = os.homedir()) {
  const found = new Map();
  let names = [];
  try { names = fs.readdirSync(home).filter((n) => n.startsWith('.claude')).sort(); } catch { /* no home */ }
  for (const n of names) {
    const p = path.join(home, n, 'projects');
    try { if (fs.statSync(p).isDirectory()) { const real = fs.realpathSync(p); if (!found.has(real)) found.set(real, p); } } catch { /* absent */ }
  }
  return [...found.values()];
}

export function runCensus({ roots, since = null, until = null }) {
  const window = parseWindow(since, until);
  const census = createCensus();
  for (const root of roots) {
    for (const file of walkJsonl(root)) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { census.scanned.unreadableFiles++; continue; }
      addTranscriptText(census, text, window, path.basename(file, '.jsonl'));
    }
  }
  return finalize(census, { window, roots });
}

export function parseArgs(argv) {
  const o = { roots: [], since: null, until: null, format: 'both' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--since') o.since = val();
    else if (a === '--until') o.until = val();
    else if (a === '--root') o.roots.push(val());
    else if (a === '--format') o.format = val();
    else if (a === '--json') o.format = 'json';
    else if (a === '--table') o.format = 'table';
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['json', 'table', 'both'].includes(o.format)) throw new Error(`--format must be json|table|both, got "${o.format}"`);
  return o;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`browser-usage-census: ${e.message}`);
    process.exit(2);
  }
  const roots = opts.roots.length ? opts.roots : defaultRoots();
  if (!roots.length) { console.error('browser-usage-census: no ~/.claude*/projects directory found (pass --root)'); process.exit(2); }
  let report;
  try { report = runCensus({ roots, since: opts.since, until: opts.until }); } catch (e) {
    console.error(`browser-usage-census: ${e.message}`);
    process.exit(2);
  }
  if (report.scanned.unreadableFiles) console.error(`browser-usage-census: WARNING ${report.scanned.unreadableFiles} transcript file(s) unreadable — counts are a lower bound`);
  if (report.scanned.files === 0) { console.error('browser-usage-census: 0 transcript files under the roots — refusing to report a zero baseline'); process.exit(3); }
  if (opts.format !== 'table') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (opts.format !== 'json') (opts.format === 'table' ? process.stdout : process.stderr).write(`${renderTable(report)}\n`);
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) main();
