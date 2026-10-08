// #320 — the REAL `claude` CLI's side of the victim-protection contract: with CLAUDE_CODE_SHELL_PREFIX = the Plafond mémoire tool wrapper, a Bash tool command
// runs at oom_score_adj 1000 (so the kernel picks a TOOL, never the keeper/CLI), its output and exit status still reach the model, and the CLI itself stays at 0.
// The real CLI is ~330 MB RSS, so this arm runs in NO scope (the ≤ 300 MB rig scopes of ledger D2 cannot hold it); scripts/e2e-memory-cap.mjs proves the scope + kill
// with a stand-in CLI that spawns tools the way this run shows the real one does. Zero tokens: a local fake Anthropic API in a net+pid namespace (bwrap).
//
//   node scripts/memory-cap/real-cli-prefix.mjs all|prefix_on|prefix_off      (re-execs itself under bwrap --unshare-net --unshare-pid)
//   MC_WRAPPER_FILE=<path>   run with THAT wrapper instead of the shipped one (the mutant harness uses it)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_HOME = process.env.MC_REAL_HOME ?? os.homedir();
const ARMS = { prefix_on: { expectAdj: 1000 }, prefix_off: { expectAdj: 0 } };
const arm = process.argv[2] ?? 'all';

if (process.env.MC_INSIDE !== '1') {
  // PARENT: one bwrap per arm; verify there is no survivor of the arm's scratch dir afterwards.
  const names = arm === 'all' ? Object.keys(ARMS) : [arm];
  const claude = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  if (!claude) { console.log('VOID no `claude` CLI on PATH — nothing was measured'); process.exit(3); }
  const probe = spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-net', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', 'true']);
  if (probe.status !== 0) { console.log('VOID bwrap net+pid namespaces unavailable — egress is not contained, nothing was measured'); process.exit(3); }
  const token = Math.random().toString(16).slice(2, 6);
  let failed = 0;
  for (const a of names) {
    if (!ARMS[a]) { console.error(`unknown arm ${a}`); process.exit(2); }
    const root = path.join(REAL_HOME, '.cache', 'memory-cap-rig', `realcli-${token}-${a}`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'home', '.claude'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: path.join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', SHELL: process.env.SHELL ?? '/bin/bash', MC_INSIDE: '1', MC_REAL_HOME: REAL_HOME, MC_ROOT: root, MC_WRAPPER_FILE: process.env.MC_WRAPPER_FILE };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const r = spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-net', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', process.execPath, '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url), a], { env, encoding: 'utf8', timeout: 120_000 });
    const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{"arm"'));
    let res; try { res = line ? JSON.parse(line) : { ok: false, error: `no result (rc=${r.status}): ${(r.stderr ?? '').slice(-300)}` }; } catch (e) { res = { ok: false, error: String(e) }; }
    // the pid namespace guarantees nothing outside survives; still print what is visible with the arm's marker
    let left = 0;
    for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { if (fs.readFileSync(`/proc/${n}/environ`, 'latin1').includes(root)) left++; } catch { /* gone */ } }
    for (const l of (r.stderr ?? '').split('\n')) if (/^ {2}(ok  |FAIL) /.test(l)) console.log(l);
    console.log(`${res.ok && left === 0 ? 'PASS' : 'FAIL'} ${a} — ${res.detail ?? res.error ?? ''}`);
    console.log(`SURVIVORS arm=${a} procs=${left}`);
    if (!(res.ok && left === 0)) failed++;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`MEMORY-CAP REAL-CLI: ${names.length - failed}/${names.length} arms PASS`);
  process.exit(failed ? 1 : 0);
}

// INSIDE the namespaces
try { fs.writeFileSync('/proc/self/oom_score_adj', '0'); } catch { /* floor above 0 */ } // a rig run from a capped member's tool starts at 1000 and so would claude: baseline 0 first
const root = process.env.MC_ROOT;
if (!root || !root.startsWith(path.join(REAL_HOME, '.cache', 'memory-cap-rig') + path.sep)) throw new Error(`refusing root ${root}`);
const { assertScratch } = await import(`${HERE_REPO}/scripts/session-budget/scratch-guard.mjs`);
const liveNames = fs.readdirSync(REAL_HOME).filter((n) => n.startsWith('.claude') || n.startsWith('.orchestra'));
assertScratch('HOME', process.env.HOME, root, liveNames.map((n) => path.join(REAL_HOME, n)));
const { OOM_TOOL_WRAPPER_SCRIPT } = await import(`${HERE_REPO}/src/shared/memory-scope.ts`);
const wrapper = path.join(root, 'oom-tool-wrapper.sh');
if (process.env.MC_WRAPPER_FILE) fs.copyFileSync(process.env.MC_WRAPPER_FILE, wrapper); else fs.writeFileSync(wrapper, OOM_TOOL_WRAPPER_SCRIPT);
fs.chmodSync(wrapper, 0o755);

const sse = (ev, d) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`;
const toolCmd = 'echo "TOOL-ADJ=$(cat /proc/self/oom_score_adj) PARENT-ADJ=$(cat /proc/$PPID/oom_score_adj)"; echo to-stderr >&2; exit 3';
const bodies = [];
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(req.url.includes('count_tokens') ? 200 : 404, { 'content-type': 'application/json' }); res.end(req.url.includes('count_tokens') ? '{"input_tokens":5}' : '{}'); return; }
    let b = {}; try { b = JSON.parse(body); } catch { /* not json */ }
    bodies.push(b);
    const hasToolResult = JSON.stringify(b.messages ?? []).includes('tool_result');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const start = sse('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: b.model ?? 'x', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } });
    if ((b.tools ?? []).length > 0 && !hasToolResult) {
      res.end(start + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } }) +
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: toolCmd, description: 'probe' }) } }) +
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }) + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }) + sse('message_stop', { type: 'message_stop' }));
    } else {
      res.end(start + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }) +
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }) + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + sse('message_stop', { type: 'message_stop' }));
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: path.join(process.env.HOME, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'sk-ant-api03-memory-cap-fake', SHELL: process.env.SHELL, LANG: 'C.UTF-8', TERM: 'dumb' };
if (arm === 'prefix_on') env.CLAUDE_CODE_SHELL_PREFIX = wrapper;
const cli = spawn('claude', ['-p', 'run it', '--output-format', 'json', '--dangerously-skip-permissions', '--model', 'sonnet', '--max-turns', '4'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let cliAdj = null;
const adjTimer = setInterval(() => { try { cliAdj = Number(fs.readFileSync(`/proc/${cli.pid}/oom_score_adj`, 'utf8')); } catch { /* gone */ } }, 30);
let so = '', se = ''; cli.stdout.on('data', (d) => (so += d)); cli.stderr.on('data', (d) => (se += d));
const rc = await new Promise((r) => { const t = setTimeout(() => { cli.kill('SIGKILL'); r('TIMEOUT'); }, 90_000); cli.on('close', (c) => { clearTimeout(t); r(c); }); });
clearInterval(adjTimer);
server.close();
const second = JSON.stringify(bodies.find((b) => JSON.stringify(b.messages ?? []).includes('tool_result'))?.messages ?? []);
const toolAdj = /TOOL-ADJ=(\d+)/.exec(second)?.[1] ?? null;
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
check('the CLI ran the tool and reported the result to the model (2nd request carries the tool_result)', second.includes('TOOL-ADJ'), second.slice(0, 160));
check(`the Bash tool command ran at oom_score_adj ${ARMS[arm].expectAdj}`, toolAdj !== null && Number(toolAdj) === ARMS[arm].expectAdj, `TOOL-ADJ=${toolAdj}`);
check('the exit status passes through the wrapper (exit 3 reaches the model)', /Exit code 3/.test(second), '');
check('stderr passes through the wrapper', second.includes('to-stderr'), '');
check('the CLI itself stays at oom_score_adj 0 (only its tool commands are raised)', cliAdj === 0, `cli adj=${cliAdj}`);
check('claude exited cleanly', rc === 0, `rc=${rc} ${se.slice(-120)}`);
for (const c of checks) console.error(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
console.log(JSON.stringify({ arm, ok: checks.every((c) => c.ok), detail: `tool adj=${toolAdj} cli adj=${cliAdj}`, failed: checks.filter((c) => !c.ok).map((c) => c.name) }));
process.exit(0);
