// Shared SAFETY guard for the C10 rigs (#235 residual): a path is writable only if it resolves inside the
// rig's scratch root AND not under a live Claude dir. Import this BEFORE any HOME override — the live dirs are
// captured at module load (a rig that re-homes first would compute "live" from its own scratch HOME).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const REAL_HOMES = [...new Set([os.homedir(), os.userInfo().homedir].map((h) => path.resolve(h)))];
export const REAL_CFG = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;

export const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
/** realpath of the deepest existing ancestor + the not-yet-existing remainder. */
export function resolveReal(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(fs.realpathSync(cur), ...rest);
}
const lexLive = (abs) => {
  for (const h of REAL_HOMES) {
    const rel = path.relative(h, abs);
    if (inside(h, abs) && rel !== '' && rel.split(path.sep)[0].startsWith('.claude')) return true;
  }
  return REAL_CFG !== null && inside(REAL_CFG, abs);
};
/** Verdict with a NAMED clause; never throws. Lexical first (no fs touch on a live path), then realpath. */
export function checkScratch(p, root) {
  const abs = path.resolve(p);
  if (lexLive(abs) || lexLive(resolveReal(abs))) return { ok: false, clause: 'live-claude-dir', detail: p };
  if (!inside(resolveReal(root), resolveReal(abs))) return { ok: false, clause: 'outside-scratch', detail: `${p} not under ${root}` };
  return { ok: true, clause: 'scratch', detail: p };
}

/** Every live Claude dir/file the invoker owns (`~/.claude*` and $CLAUDE_CONFIG_DIR). */
export function liveDirs() {
  const out = new Set();
  for (const h of REAL_HOMES) {
    for (const n of fs.existsSync(h) ? fs.readdirSync(h) : []) if (n.startsWith('.claude') && !n.endsWith('.json')) out.add(path.join(h, n));
  }
  if (REAL_CFG && fs.existsSync(REAL_CFG)) out.add(REAL_CFG);
  return [...out].sort();
}
const h16 = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 16);
const readRetry = (f) => { for (let i = 0; i < 4; i++) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; } } return null; };
const mcpKeys = (f) => { for (let i = 0; i < 4; i++) { const t = readRetry(f); if (t === null) return null; try { return Object.keys(JSON.parse(t).mcpServers ?? {}).sort().join(','); } catch { /* torn write: retry */ } } return 'UNPARSEABLE'; };
/** Independent canary of every live dir, taken with `find` (depth ≤ 2). STRICT = exactly what the incidents stripped:
 *  the symlink set, the inherit manifest and the MCP server KEY list of `<dir>/.claude.json` (never its contents —
 *  that file churns with project state). LISTING = every name (+type +link target) for churn attribution only. */
export function liveCanary() {
  const out = {};
  for (const d of liveDirs()) {
    if (!fs.statSync(d).isDirectory()) { out[d] = { file: h16(fs.readFileSync(d)) }; continue; }
    const listing = execFileSync('find', [d, '-maxdepth', '2', '-printf', '%P\t%y\t%l\n'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean).sort();
    const links = listing.filter((l) => l.split('\t')[1] === 'l');
    const m = readRetry(path.join(d, '.orchestra-inherited.json'));
    out[d] = { links: h16(links.join('\n')), linkCount: links.length, manifest: m === null ? null : h16(m), mcp: mcpKeys(path.join(d, '.claude.json')), listing };
  }
  return out;
}
/** strict = dirs whose links/manifest/MCP keys/file content differ (a FAILURE); churn = other name changes (informational). */
export function canaryDiff(before, after) {
  const strict = []; const churn = {};
  for (const d of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[d]; const b = after[d];
    if (!a || !b) { strict.push(`${d} (dir ${a ? 'vanished' : 'appeared'})`); continue; }
    if (a.file !== undefined || b.file !== undefined) { if (a.file !== b.file) strict.push(`${d} (file content)`); continue; }
    const why = ['links', 'manifest', 'mcp'].filter((k) => a[k] !== b[k]);
    if (why.length) strict.push(`${d} (${why.join('+')}: links ${a.linkCount}->${b.linkCount}, mcp [${a.mcp}]->[${b.mcp}])`);
    const A = new Set(a.listing); const B = new Set(b.listing);
    const added = [...B].filter((x) => !A.has(x)).map((x) => x.split('\t')[0]);
    const removed = [...A].filter((x) => !B.has(x)).map((x) => x.split('\t')[0]);
    if (added.length || removed.length) churn[d] = { added: added.slice(0, 12), removed: removed.slice(0, 12), nAdded: added.length, nRemoved: removed.length };
  }
  return { strict, churn };
}
