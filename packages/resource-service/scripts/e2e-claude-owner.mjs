// A6 real-session proof: a REAL `claude` CLI (print mode, fake Anthropic API on loopback, dummy key, zero tokens) is told by the fake API to run a Bash command;
// that command runs `resctl run start --owner auto` + `resctl exec`. Asserts what the process tree REALLY looks like, then kills the session and watches the grace.
//   node scripts/e2e-claude-owner.mjs [--claude <path>] [--mutant <id>] [--proof] [--keep]
//   --mutant <id>  run the CLI from a scratch COPY with the edits of mutants/a6.json[<id>] (must turn the verdict FAIL)
//   --proof        baseline + every mutant of mutants/a6.json marked "rig": true; PASS only if baseline PASS and each mutant FAIL
// Containment: the whole run happens inside `bwrap --unshare-net --unshare-pid --ro-bind / /` (only the scratch dir + /tmp writable): no egress, the host's
// ~/.claude* is read-only, every process dies with the run. RESCTL_RIG_UNCONTAINED=1 opts out (echoed). Last line: `E2E-CLAUDE-OWNER: PASS|FAIL|VOID`.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mutants = () => JSON.parse(fs.readFileSync(path.join(PKG, 'mutants', 'a6.json'), 'utf8'));

// ---------------------------------------------------------------- outer: scratch dir + containment + --proof
if (!argv.includes('--inner')) {
  const tmp = process.env.TMPDIR || os.tmpdir();
  const runOne = (mutant) => {
    const root = fs.mkdtempSync(path.join(tmp, 'resctl-claude-'));
    for (const d of ['home', 'config', 'state', 'work', 'tmp', 'out']) fs.mkdirSync(path.join(root, d));
    const inner = [process.execPath, fileURLToPath(import.meta.url), '--inner', '--root', root, ...(flag('--claude') ? ['--claude', flag('--claude')] : []), ...(mutant ? ['--mutant', mutant] : [])];
    let cmd;
    if (process.env.RESCTL_RIG_UNCONTAINED === '1') {
      console.log('CONTAINMENT: none (RESCTL_RIG_UNCONTAINED=1) — the dummy key still cannot spend tokens');
      cmd = inner;
    } else {
      if (spawnSync('bwrap', ['--version']).status !== 0) {
        console.log('VOID: bwrap is not available (set RESCTL_RIG_UNCONTAINED=1 to run without containment)');
        console.log('E2E-CLAUDE-OWNER: VOID');
        process.exit(3);
      }
      cmd = ['bwrap', '--unshare-net', '--unshare-pid', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', root, root, ...inner];
    }
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', timeout: 240_000 });
    const verdict = fs.existsSync(path.join(root, 'verdict')) ? fs.readFileSync(path.join(root, 'verdict'), 'utf8').trim() : 'VOID';
    const failedFile = path.join(root, 'failed.json');
    const failed = fs.existsSync(failedFile) ? JSON.parse(fs.readFileSync(failedFile, 'utf8')) : [];
    if (!argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
    else console.log(`kept ${root}`);
    return { verdict, status: r.status, failed };
  };
  if (argv.includes('--proof')) {
    const arms = [{ id: null }, ...mutants().filter((m) => m.rig).map((m) => ({ id: m.id, expect: m.rigExpect }))];
    const rows = arms.map((a) => ({ arm: a.id ?? 'baseline', expect: a.expect, ...runOne(a.id) }));
    // a mutant counts as killed only by the clause it targets (`rigExpect`), never by any red (a crash would read as a kill)
    for (const r of rows) {
      r.tied = r.expect ? r.failed.some((n) => n.includes(r.expect)) : true;
      console.log(`${r.arm.padEnd(40)} ${r.verdict}${r.expect ? `  tied clause "${r.expect}": ${r.tied ? 'FAILED as expected' : 'NOT failed'}` : ''}${r.verdict === 'FAIL' ? `  [${r.failed.join(' | ')}]` : ''}`);
    }
    const ok = rows[0].verdict === 'PASS' && rows.slice(1).every((r) => r.verdict === 'FAIL' && r.expect && r.tied);
    console.log(`PROOF: ${ok ? 'baseline PASS and every mutant FAIL' : 'NOT proven'}`);
    console.log(`E2E-CLAUDE-OWNER: ${ok ? 'PASS' : 'FAIL'}`);
    process.exit(ok ? 0 : 1);
  }
  const { verdict } = runOne(flag('--mutant'));
  console.log(`E2E-CLAUDE-OWNER: ${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'VOID' ? 3 : 1);
}

// ---------------------------------------------------------------- inner (runs in the sandbox)
const root = flag('--root');
const P = (...p) => path.join(root, ...p);
const log = (m) => console.log(`[rig] ${m}`);
const checks = [];
let voided = null;
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

// Scratch guard: never hand the CLI a live config dir.
const realHome = os.userInfo().homedir;
for (const d of [P('home'), P('config')]) {
  const rp = fs.realpathSync(d);
  if (!rp.startsWith(fs.realpathSync(process.env.TMPDIR || os.tmpdir())) || rp.startsWith(path.join(realHome, '.claude'))) throw new Error(`refusing scratch dir ${rp}`);
}

// The CLI under test: the package itself, or a scratch copy carrying one mutant.
let pkg = PKG;
if (flag('--mutant')) {
  const m = mutants().find((x) => x.id === flag('--mutant'));
  if (!m) throw new Error(`no mutant ${flag('--mutant')} in mutants/a6.json`);
  pkg = P('pkg-mut');
  fs.cpSync(path.join(PKG, 'src'), path.join(pkg, 'src'), { recursive: true });
  fs.cpSync(path.join(PKG, 'bin'), path.join(pkg, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(PKG, 'package.json'), path.join(pkg, 'package.json'));
  for (const e of m.edits) {
    const f = path.join(pkg, e.file);
    const text = fs.readFileSync(f, 'utf8');
    const n = text.split(e.find).length - 1;
    if (n !== 1) throw new Error(`${m.id}: anchor occurs ${n}x in ${e.file}`);
    fs.writeFileSync(f, text.replace(e.find, () => e.to));
  }
  log(`MUTANT ${m.id}: ${m.why}`);
}
const BIN = path.join(pkg, 'bin', 'resctl.mjs');
const NODE = process.execPath;
const STATE = P('state');
const RUN = 'rig-auto';

// Fake Anthropic API: the first tool-carrying request → a Bash tool call; the one carrying its tool_result → text; anything else → text. Zero tokens.
const requests = [];
const sse = (ev, d) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`;
const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const head = (model) => sse('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
const textReply = (model, text) => head(model) + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + sse('content_block_stop', { type: 'content_block_stop', index: 0 }) + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }) + sse('message_stop', { type: 'message_stop' });
const toolReply = (model, name, input) => head(model) + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fake_1', name, input: {} } }) + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) + sse('content_block_stop', { type: 'content_block_stop', index: 0 }) + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }) + sse('message_stop', { type: 'message_stop' });

// What the session's Bash tool runs: dump its own ancestry, declare a run with the owner resolved from the process tree, start one lane, then block.
fs.writeFileSync(P('chain.mjs'), `
import fs from 'node:fs';
const rows = [];
for (let p = process.pid, i = 0; p > 1 && i < 40; i++) {
  let s; try { s = fs.readFileSync('/proc/' + p + '/stat', 'utf8'); } catch { break; }
  const comm = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
  const ppid = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
  let exe = ''; try { exe = fs.readlinkSync('/proc/' + p + '/exe'); } catch {}
  let cmd = ''; try { cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').split('\\0').slice(0, 3).join(' ').slice(0, 90); } catch {}
  rows.push({ pid: p, ppid, comm, exe, cmd });
  p = ppid;
}
fs.writeFileSync(process.argv[2], JSON.stringify(rows));
`);
const O = (f) => P('out', f);
const toolCommand = [
  `'${NODE}' '${P('chain.mjs')}' '${O('chain.json')}'`,
  `'${NODE}' '${BIN}' run start --id ${RUN} --owner auto > '${O('start.out')}' 2> '${O('start.err')}'`,
  `echo $? > '${O('start.rc')}'`,
  `('${NODE}' '${BIN}' exec --run ${RUN} -- sleep 120 > /dev/null 2>&1 &)`,
  `sleep 110`,
].join('; ');

const api = http.createServer((req, res) => {
  const ua = String(req.headers['user-agent'] ?? '');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":10}'); }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') { requests.push({ other: `${req.method} ${url.pathname}` }); res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"fake"}}'); }
    const model = body.model ?? 'claude-fake';
    const hasToolResult = JSON.stringify(body.messages ?? []).includes('"tool_result"');
    const toolBearing = Array.isArray(body.tools) && body.tools.some((t) => t.name === 'Bash');
    const kind = hasToolResult ? 'followup' : toolBearing ? 'main' : 'side';
    requests.push({ kind, model, ua });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(kind === 'main' ? toolReply(model, 'Bash', { command: toolCommand, description: 'declare the run' }) : textReply(model, kind === 'followup' ? 'done' : 'ok'));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;

const claudeBin = flag('--claude') ?? spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
if (!claudeBin) { console.log('VOID: no claude on PATH'); fs.writeFileSync(P('verdict'), 'VOID'); process.exit(3); }
const version = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: P('home'), CLAUDE_CONFIG_DIR: P('config') } }).stdout.trim();
log(`claude ${claudeBin} (${version}); fake API ${base}; resctl ${BIN}`);
const versionNumber = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(version)?.[1] ?? null;

// env allowlist (nothing of the caller's environment but PATH/locale leaks in)
const childEnv = {
  PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', TERM: 'dumb', SHELL: '/bin/bash',
  HOME: P('home'), CLAUDE_CONFIG_DIR: P('config'), TMPDIR: P('tmp'),
  ANTHROPIC_API_KEY: 'sk-ant-api03-fake-0000000000000000000000000000000000000000000000000000000000000000-AAAAAAAA', ANTHROPIC_BASE_URL: base,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
  RESCTL_STATE_DIR: STATE, RESCTL_NO_AUTOSTART: '1', RESCTL_GRACE: '4s', RESCTL_TICK: '100ms', RESCTL_TERM_WAIT: '500ms',
};
const claudeArgs = ['-p', 'declare the run', '--bare', '--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash', '--no-session-persistence'];

// The reaper daemon the CLI would auto-start (grace 4 s so the run is observable), plus the session behind a node wrapper (the keeper's shape: node → claude).
const daemon = spawn(NODE, [BIN, 'serve'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let daemonLog = '';
daemon.stderr.on('data', (d) => (daemonLog += d));
const wrapperSrc = `
const { spawn } = require('node:child_process');
const c = spawn(${JSON.stringify(claudeBin)}, ${JSON.stringify(claudeArgs)}, { stdio: ['ignore', 'inherit', 'inherit'], cwd: ${JSON.stringify(P('work'))} });
require('node:fs').writeFileSync(${JSON.stringify(O('claude.pid'))}, String(c.pid));
c.on('exit', (code, sig) => process.exit(code ?? 1));`;
const wrapper = spawn(NODE, ['-e', wrapperSrc], { env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });

const readStat = (pid) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: f[0], ppid: Number(f[1]), startTime: Number(f[19]) };
  } catch { return null; }
};
const comm = (pid) => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; } };
const alive = (id) => { const s = readStat(id.pid); return !!s && s.startTime === id.startTime && s.state !== 'Z'; };
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'state.json'), 'utf8')); } catch { return { runs: {} }; } };
const waitFor = async (what, fn, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); }
};

try {
  const gotRun = await waitFor('the run declared inside the session', () => fs.existsSync(O('start.rc')) && fs.existsSync(O('chain.json')), 90_000);
  const claudePid = fs.existsSync(O('claude.pid')) ? Number(fs.readFileSync(O('claude.pid'), 'utf8')) : 0;
  if (!gotRun || !claudePid) {
    voided = `the session never ran the Bash command (requests: ${JSON.stringify(requests)}; claude.pid ${claudePid})`;
  } else {
    const claudeId = { pid: claudePid, startTime: readStat(claudePid)?.startTime };
    const chain = JSON.parse(fs.readFileSync(O('chain.json'), 'utf8'));
    log('MEASURED process tree of the command the session ran (nearest first):');
    for (const r of chain) console.log(`       ${String(r.pid).padStart(7)} ppid ${String(r.ppid).padStart(7)}  comm=${r.comm.padEnd(8)} exe=${path.basename(r.exe || '?').padEnd(14)} ${r.cmd}`);
    const claudeRow = chain.find((r) => r.pid === claudePid);
    check('instrument: the session process is in the command\'s ancestry and is the process the rig started', !!claudeRow);
    check('the CLI\'s parent is a shell, NOT the claude process', chain[1]?.pid !== claudePid, `parent of resctl = ${chain[1]?.comm}(${chain[1]?.pid})`);
    check('the node wrapper (keeper stand-in) sits ABOVE claude, so "parent of parent" is not claude either', chain.some((r) => r.pid === wrapper.pid) && chain.findIndex((r) => r.pid === wrapper.pid) > chain.findIndex((r) => r.pid === claudePid));
    check('claude is recognised by comm (`claude`), and its exe basename is NOT claude (native install: the version)', claudeRow?.comm === 'claude' && path.basename(claudeRow.exe) !== 'claude', `comm=${claudeRow?.comm} exe=${path.basename(claudeRow?.exe ?? '?')}`);

    const rc = fs.readFileSync(O('start.rc'), 'utf8').trim();
    check('`run start --owner auto` run by the agent exits 0 and prints the id', rc === '0' && fs.readFileSync(O('start.out'), 'utf8').trim() === RUN, `rc=${rc} stderr=${fs.readFileSync(O('start.err'), 'utf8').trim()}`);
    const run = state().runs[RUN];
    check('the recorded owner is the session process (pid + starttime)', !!run && run.owner.pid === claudePid && run.owner.startTime === claudeId.startTime, `owner=${JSON.stringify(run?.owner)} session=${JSON.stringify(claudeId)}`);

    const lane = await waitFor('the lane', () => state().runs[RUN]?.lanes?.[0], 20_000);
    check('instrument: the lane started from the session is recorded', !!lane);
    await sleep(1500);
    check('while the session lives the run is alive (no grace) and the lane runs', state().runs[RUN]?.state === 'alive' && !!lane && alive({ pid: lane.pid, startTime: lane.startTime }));

    // kill the session (SIGKILL, identity re-read right before) → the grace starts, then the lane is cleaned
    if (alive(claudeId) && comm(claudePid) === 'claude') process.kill(claudePid, 'SIGKILL');
    const inGrace = await waitFor('the grace', () => state().runs[RUN]?.state === 'grace' && state().runs[RUN].graceEndsAt, 15_000);
    check('killing the session starts the grace', !!inGrace);
    if (inGrace) {
      check('the lane is still alive inside the grace', lane && alive({ pid: lane.pid, startTime: lane.startTime }));
      const gone = await waitFor('the lane to be cleaned', () => lane && !alive({ pid: lane.pid, startTime: lane.startTime }) && state().runs[RUN]?.state === 'cleaned', 30_000);
      check('after the grace the lane is gone and the run is cleaned', !!gone);
      check('it was not cleaned before the grace ended', Date.now() >= inGrace);
    }
    check('instrument: the binary is a real Claude Code (`--version` is `<semver> (Claude Code)`) and the fake API saw its own `claude-cli/<version>` user-agent', !!versionNumber && requests.some((r) => r.ua.startsWith(`claude-cli/${versionNumber}`)), `version=${JSON.stringify(version)} user-agents=${[...new Set(requests.map((r) => r.ua))].join(' ; ')}`);
    const main = requests.filter((r) => r.kind === 'main').length;
    check('instrument: the fake API served the session (≥ 1 tool-bearing request: the Bash call was really issued by a model turn)', main >= 1, `requests=${requests.map((r) => r.kind ?? r.other).join(',')}`);
  }
} catch (e) {
  voided = `rig error: ${e.stack}`;
} finally {
  for (const p of [wrapper.pid, daemon.pid]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  api.close();
}
const failed = checks.filter((c) => !c.ok);
const verdict = voided ? 'VOID' : failed.length ? 'FAIL' : 'PASS';
if (voided) console.log(`VOID: ${voided}`);
if (verdict !== 'PASS' && daemonLog) console.log(`serve log:\n${daemonLog.split('\n').slice(-12).join('\n')}`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(' | ')}` : ''}`);
fs.writeFileSync(P('failed.json'), JSON.stringify(failed.map((c) => c.name)));
fs.writeFileSync(P('verdict'), verdict);
process.exit(verdict === 'PASS' ? 0 : verdict === 'VOID' ? 3 : 1);
