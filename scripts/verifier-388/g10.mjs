// G10 live-state hygiene snapshot/diff (verifier seat 1, vague #388). READ-ONLY on live state.
// usage: node g10.mjs snap <out.json> | node g10.mjs diff <a.json> <b.json>
// Hashes the CONFIG/SECRETS files (not agents' normal churn): per ~/.claude* dir settings/CLAUDE/LESSONS (symlink target + content hash) + the
// inheritance surface (links, managed names, manifest, mcpServers KEYS); .credentials.json + store.json are recorded as INFO (churn by running agents / the live app).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { liveSnapshot } from './lib.mjs';

const H = os.userInfo().homedir;
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return `ERR:${e.code}`; } };
const lk = (f) => { try { return fs.lstatSync(f).isSymbolicLink() ? fs.readlinkSync(f) : null; } catch { return null; } };
const entry = (f) => ({ sha: sha(f), link: lk(f) });
function snap() {
  const strict = {}, info = {};
  const claudeDirs = [path.join(H, '.claude'), ...fs.readdirSync(H).filter((n) => n.startsWith('.claude-')).map((n) => path.join(H, n))].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  for (const d of claudeDirs) {
    for (const n of ['settings.json', 'CLAUDE.md', 'LESSONS.md', 'statusline-command.sh']) { const f = path.join(d, n); if (fs.existsSync(f) || lk(f)) strict[f] = entry(f); }
    strict[`${d}#inheritance-surface`] = liveSnapshot(d);
    const c = path.join(d, '.credentials.json'); if (fs.existsSync(c)) info[c] = entry(c);
    const m = path.join(d, '.orchestra-inherited.json'); if (fs.existsSync(m)) info[m] = entry(m);
  }
  try { strict[`${H}/.claude.json#mcpServers-keys`] = Object.keys(JSON.parse(fs.readFileSync(path.join(H, '.claude.json'), 'utf8')).mcpServers ?? {}).sort().join(','); } catch (e) { strict[`${H}/.claude.json#mcpServers-keys`] = `ERR:${e.code ?? e.message}`; }
  const cfg = path.join(H, '.config', 'orchestra');
  for (const f of ['Preferences', 'Network Persistent State', 'orchestra/secrets.json', 'orchestra/usage.json']) { const p = path.join(cfg, f); if (fs.existsSync(p)) strict[p] = entry(p); }
  info[path.join(cfg, 'orchestra/store.json')] = entry(path.join(cfg, 'orchestra/store.json'));
  // #389: the human's REAL gnome-keyring files (bytes only — never opened as a keyring); mtime recorded as info.
  const kr = path.join(H, '.local', 'share', 'keyrings');
  try { for (const n of fs.readdirSync(kr)) { const f = path.join(kr, n); try { if (!fs.lstatSync(f).isFile()) continue; } catch { continue; } strict[f] = entry(f); info[`${f}#mtimeMs`] = String(fs.statSync(f).mtimeMs); } } catch { /* none */ }
  const od = path.join(H, '.orchestra');
  const churn = /^(bus\.sqlite.*|admission\.state|session-keys\.json|sock|.*\.log)$/;
  for (const n of fs.readdirSync(od)) {
    const f = path.join(od, n);
    let st; try { st = fs.lstatSync(f); } catch { continue; }
    if (!st.isFile() || churn.test(n)) continue;
    strict[f] = entry(f);
  }
  return { at: new Date().toISOString(), strict, info };
}
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'snap') {
  const s = snap(); fs.writeFileSync(a, JSON.stringify(s, null, 1));
  console.log(`G10 snap ${a}: strict=${Object.keys(s.strict).length} info=${Object.keys(s.info).length}`);
} else if (cmd === 'diff') {
  const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
  const diffs = [];
  for (const k of new Set([...Object.keys(A.strict), ...Object.keys(B.strict)])) if (JSON.stringify(A.strict[k]) !== JSON.stringify(B.strict[k])) diffs.push(k);
  const infoDiffs = [...new Set([...Object.keys(A.info), ...Object.keys(B.info)])].filter((k) => JSON.stringify(A.info[k]) !== JSON.stringify(B.info[k]));
  console.log(`G10 ${diffs.length ? 'DIRTY' : 'CLEAN'} strict_files=${Object.keys(A.strict).length} strict_diffs=${diffs.length}${diffs.length ? ' ' + JSON.stringify(diffs) : ''} | info_changed(churn expected)=${JSON.stringify(infoDiffs.map((k) => path.basename(path.dirname(k)) + '/' + path.basename(k)))}`);
  process.exit(diffs.length ? 1 : 0);
} else { console.error('usage: snap <out> | diff <a> <b>'); process.exit(2); }
