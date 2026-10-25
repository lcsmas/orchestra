// #399 — must-FAIL proof for the "no in-process browser MCP server" clause of scripts/verify-answerable-wiring.mjs.
// Re-adds an `mcpServers: { browser: … }` option at the real query() launch site of src/main/agent-sdk.ts (anchor must match EXACTLY once), runs the
// wiring gate and requires it RED naming that clause; restores the file byte-exact and proves it with cmp. The unmutated gate must be GREEN first (control).
// Usage: node scripts/mutate-no-browser-mcp.mjs     (exit 0 = control green AND mutant killed AND restore exact)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src/main/agent-sdk.ts');
const backup = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'b399-nobmcp-')), 'agent-sdk.ts.orig');
const gate = () => spawnSync(process.execPath, [path.join(root, 'scripts/verify-answerable-wiring.mjs')], { cwd: root, encoding: 'utf8', timeout: 280000 });

const control = gate();
console.log(`control (unmutated) → rc ${control.status}`);
if (control.status !== 0) { console.log(control.stdout.slice(-1500), control.stderr.slice(-500)); console.log('RESULT: INVALID — the unmutated gate is not green'); process.exit(1); }

const src = fs.readFileSync(target, 'utf8');
const anchor = '  session.q = query({\n    prompt: promptStream(session),\n    options: {\n';
const hits = src.split(anchor).length - 1;
if (hits !== 1) { console.log(`RESULT: INVALID — anchor occurs ${hits}x in agent-sdk.ts (must be exactly 1)`); process.exit(1); }
fs.copyFileSync(target, backup);
let verdict = 'SURVIVED';
try {
  fs.writeFileSync(target, src.replace(anchor, anchor + "      mcpServers: { browser: { type: 'stdio', command: 'true' } },\n"));
  const mut = gate();
  const named = /FAIL.*no in-process browser MCP server is passed to query\(\)|no in-process browser MCP server is passed to query\(\)/.test(mut.stdout + mut.stderr);
  console.log(`mutant (mcpServers.browser re-added) → rc ${mut.status}, names the clause: ${named}`);
  if (mut.status !== 0 && named) verdict = 'KILLED';
} finally {
  fs.copyFileSync(backup, target);
}
try { execFileSync('cmp', [backup, target]); console.log('restored byte-exact (cmp OK)'); } catch { console.log('RESTORE NOT BYTE-EXACT'); process.exit(2); }
console.log(`RESULT: ${verdict}`);
process.exit(verdict === 'KILLED' ? 0 : 1);
