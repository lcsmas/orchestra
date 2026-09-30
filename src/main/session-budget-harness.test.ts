// Unit tests for the session-budget harness pieces (#208): scripts/session-budget/*.mjs.
// The full suite (real CLI, ~13 s) is `pnpm run test:session-budget`; these are the fast guards
// on the instruments themselves — a rig that cannot fail is worse than no rig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const S = (f: string) => `${REPO}/scripts/session-budget/${f}`;
const api = await import(S('fake-anthropic-api.mjs'));
const fixture = await import(S('fixture.mjs'));
const guard = await import(S('scratch-guard.mjs'));
const mutants = await import(S('mutants.mjs'));
const proc = await import(S('proc-census.mjs'));
const armsMod = await import(S('arms.mjs'));
const canary = await import(S('canary.mjs'));

function scratch(prefix: string): string {
  const base = path.join(os.homedir(), '.cache', 'session-budget-test');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

// ── fake API ────────────────────────────────────────────────────────────────

test('classifyRequest: the budget axes', () => {
  assert.equal(api.classifyRequest('POST', '/v1/messages'), 'model');
  assert.equal(api.classifyRequest('POST', '/v1/messages/'), 'model');
  assert.equal(api.classifyRequest('POST', '/v1/messages/count_tokens'), 'count_tokens');
  assert.equal(api.classifyRequest('GET', '/v1/models'), 'models');
  assert.equal(api.classifyRequest('GET', '/api/claude_cli/bootstrap'), 'bootstrap');
  assert.equal(api.classifyRequest('GET', '/anything/else'), 'other');
  assert.equal(api.classifyRequest('GET', '/v1/messages'), 'other', 'a GET is not a model call');
});

test('fake API: streamed reply is wire-shaped, recorded by type, and carries planted markers', async () => {
  const f = await api.startFakeApi({ markers: { a: 'NEEDLE-A', b: 'NEEDLE-B' } });
  try {
    const body = JSON.stringify({ model: 'm1', max_tokens: 5, stream: true, tools: [{ name: 't' }], messages: [{ role: 'user', content: 'x NEEDLE-A y' }] });
    const res = await fetch(`${f.url}/v1/messages?beta=true`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-api-key': 'k' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const txt = await res.text();
    const events = [...txt.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2])]);
    assert.deepEqual(events.map((e) => e[0]), ['message_start', 'content_block_start', 'ping', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    for (const [name, data] of events) assert.equal(data.type, name, 'SSE event name must equal data.type');
    assert.equal(events[0][1].message.role, 'assistant');
    assert.equal(events[5][1].delta.stop_reason, 'end_turn');
    const ct = await fetch(`${f.url}/v1/messages/count_tokens`, { method: 'POST', body: JSON.stringify({ model: 'm1', messages: [] }) });
    assert.equal(typeof (await ct.json()).input_tokens, 'number');
    const nf = await fetch(`${f.url}/v1/nope`);
    assert.equal(nf.status, 404);
    assert.deepEqual(f.counts(), { model: 1, count_tokens: 1, other: 1 });
    const model = f.requests.find((r: any) => r.type === 'model');
    assert.equal(model.model, 'm1');
    assert.equal(model.tools, 1);
    assert.equal(model.auth, 'x-api-key');
    assert.deepEqual(model.marks, ['a']);
  } finally { await f.stop(); }
});

test('fake API: a non-streamed model call gets a JSON message', async () => {
  const f = await api.startFakeApi();
  try {
    const res = await fetch(`${f.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [] }) });
    const j = await res.json();
    assert.equal(j.type, 'message');
    assert.equal(j.stop_reason, 'end_turn');
  } finally { await f.stop(); }
});

test('egress proxy: a CONNECT is RECORDED and REFUSED, and a resetting client cannot crash the fake', async () => {
  const f = await api.startFakeApi();
  try {
    const sock = net.connect(f.proxyPort, '127.0.0.1');
    const reply: string = await new Promise((resolve) => {
      let buf = '';
      sock.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf); } });
      sock.on('error', () => resolve(buf));
      sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
    // an abrupt reset right after CONNECT (the crash the first spike hit)
    const rst = net.connect(f.proxyPort, '127.0.0.1');
    rst.on('error', () => {});
    rst.write('CONNECT evil.example:443 HTTP/1.1\r\n\r\n', () => rst.resetAndDestroy());
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(f.egress.map((e: any) => e.target), ['api.anthropic.com:443', 'evil.example:443']);
    // a plain-HTTP proxied request (absolute URI) is recorded as host:port too, like a CONNECT target
    const http = await import('node:http');
    await new Promise<void>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: f.proxyPort, path: 'http://plain.example.invalid/x', method: 'GET', headers: { host: 'plain.example.invalid' } }, (res) => { res.resume(); res.on('end', () => resolve()); });
      r.on('error', () => resolve());
      r.end();
    });
    assert.equal(f.egress[f.egress.length - 1].target, 'plain.example.invalid:80');
    // still serving
    const res = await fetch(`${f.url}/v1/messages/count_tokens`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(f.counts().model ?? 0, 0, 'egress is NOT a model request');
  } finally { await f.stop(); }
});

// ── fixture ─────────────────────────────────────────────────────────────────

function treeHash(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      if (n === '.git') continue;
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(path.relative(dir, p)).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

test('fixture: generated (not hand-maintained) — deterministic, heavy on the #176 axes, sentinels planted', () => {
  const a = scratch('fx-a');
  const b = scratch('fx-b');
  try {
    const fa = fixture.generateHeavyFixture(path.join(a, 'r'));
    const fb = fixture.generateHeavyFixture(path.join(b, 'r'));
    assert.equal(treeHash(fa.dir), treeHash(fb.dir), 'two generations must be byte-identical');
    // heaviness as LITERALS
    assert.equal(fs.readdirSync(path.join(fa.dir, '.claude', 'skills')).length, 60);
    assert.equal(fs.readdirSync(path.join(fa.dir, '.claude', 'rules')).length, 50);
    assert.ok(fs.statSync(path.join(fa.dir, 'CLAUDE.md')).size >= 48 * 1024);
    const mcp = JSON.parse(fs.readFileSync(path.join(fa.dir, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['fixsrv1', 'fixsrv2', 'fixsrv3', 'fixsrv4']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fa.dir, '.claude', 'settings.json'), 'utf8')).enableAllProjectMcpServers, true);
    // sentinels
    assert.deepEqual(Object.keys(fa.markers).sort(), ['claude_md', 'mcp_tool_last', 'rule_last', 'skill_last']);
    assert.ok(fs.readFileSync(path.join(fa.dir, 'CLAUDE.md'), 'utf8').includes(fa.markers.claude_md));
    assert.ok(fs.readFileSync(path.join(fa.dir, '.claude', 'rules', 'rule-49.md'), 'utf8').includes(fa.markers.rule_last));
    assert.ok(fs.existsSync(path.join(fa.dir, '.claude', 'skills', fa.markers.skill_last)));
    assert.equal(fa.markers.mcp_tool_last, 'fixsrv4_tool_14');
    // a git repo with one commit
    assert.ok(fs.existsSync(path.join(fa.dir, '.git')));
    // refuses a non-empty dir (never overlays a real repo)
    assert.throws(() => fixture.generateHeavyFixture(fa.dir), /not empty/);
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test('fixture MCP server answers initialize/tools/list/tools/call over stdio', async () => {
  const child = spawn(process.execPath, [fixture.FAKE_MCP_SERVER, '--name', 'zz', '--tools', '3'], { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    const lines: string[] = [];
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'bogus' })}\n`);
    for (let i = 0; i < 100 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 30));
    const [init, list, bogus] = lines.map((l) => JSON.parse(l));
    assert.equal(init.result.serverInfo.name, 'zz');
    assert.deepEqual(list.result.tools.map((t: any) => t.name), ['zz_tool_00', 'zz_tool_01', 'zz_tool_02']);
    assert.equal(bogus.error.code, -32601);
  } finally { child.kill('SIGKILL'); }
});

// ── scratch guard (D7): must-FAIL on every live dir, must-PASS on a look-alike scratch ─────────────

test('scratch guard REFUSES live dirs, escapes and symlinks into them — and ACCEPTS a fresh scratch dir', () => {
  const root = scratch('guard');
  try {
    const liveDir = path.join(root, 'fake-live-claude');
    fs.mkdirSync(liveDir);
    const live = [liveDir];
    const scr = path.join(root, 'run1');
    fs.mkdirSync(path.join(scr, 'home', '.claude'), { recursive: true });
    // must-PASS look-alike: same shape as a config dir, but a fresh scratch one
    assert.doesNotThrow(() => guard.assertScratch('CLAUDE_CONFIG_DIR', path.join(scr, 'home', '.claude'), scr, live));
    // must-FAIL: the live dir itself, inside it, above it, outside the scratch root, and a symlink into it
    const refuse = (p: string, re: RegExp, scratchRoot = scr) =>
      assert.throws(() => guard.assertScratch('X', p, scratchRoot, live), (e: Error) => re.test(e.message) && /scratch-guard: REFUSED/.test(e.message), p);
    refuse(liveDir, /resolves to\/into\/over the live dir/);               // the live dir itself (also outside scr)
    refuse(liveDir, /resolves to\/into\/over the live dir/, root);         // ... and with a root that contains it
    refuse(path.join(liveDir, 'sub'), /live dir/, root);                    // inside a live dir
    refuse(root, /live dir/, root);                                          // above a live dir
    fs.symlinkSync(liveDir, path.join(scr, 'link'));
    refuse(path.join(scr, 'link'), /live dir/);                              // inside scratch by name, live by resolution
    refuse(path.join(root, 'elsewhere'), /not inside the scratch root/);     // not live, but outside the scratch root
    assert.throws(() => guard.assertScratch('X', path.join(os.homedir(), '.claude'), scr), /scratch-guard: REFUSED/);   // default live list = the real ~/.claude*
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('liveDirs() names ~/.claude*, ~/.orchestra*, and the invoker\'s CLAUDE_CONFIG_DIR / ORCHESTRA_HOME', () => {
  const l: string[] = guard.liveDirs({ CLAUDE_CONFIG_DIR: '/x/cfg-live', ORCHESTRA_HOME: '/x/orch-live' });
  for (const want of ['/x/cfg-live', '/x/orch-live', path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.orchestra')]) {
    const real = fs.existsSync(want) ? fs.realpathSync(want) : want;
    assert.ok(l.some((p) => p === want || p === real), `missing ${want}`);
  }
});

// ── load-time mutant ────────────────────────────────────────────────────────

test('mutant boot-context-read: its anchor matches the SHIPPED agent-sdk.ts exactly once, and only inserts the boot call', () => {
  const src = fs.readFileSync(`${REPO}/src/main/agent-sdk.ts`, 'utf8');
  const m = mutants.MUTANTS['boot-context-read'];
  assert.equal([...src.matchAll(m.find)].length, 1, 'anchor drifted: the mutant no longer describes the shipped code');
  const mutated = src.replace(m.find, m.replace);
  assert.equal(mutated.split('\n').length, src.split('\n').length + 1, 'exactly one line inserted');
  assert.match(mutated, /  void consume\(session\);\n  refreshContextUsage\(wsId\);\n/);
  assert.doesNotMatch(src, /  void consume\(session\);\n  refreshContextUsage\(wsId\);/, 'shipped code must not already read context at boot');
});

test('mutant loader: PATTERN-GONE when the anchor is absent, unknown mutant rejected, inactive is a no-op', async () => {
  const fake = (text: string) => async () => ({ format: 'module-typescript', source: Buffer.from(text) });
  const url = 'file:///x/src/main/agent-sdk.ts';
  await mutants.initialize({ mutant: null });
  const untouched = await mutants.load(url, {}, fake('nothing here'));
  assert.equal(String(untouched.source), 'nothing here');
  await mutants.initialize({ mutant: 'boot-context-read' });
  await assert.rejects(() => mutants.load(url, {}, fake('nothing here')), /PATTERN-GONE.*matched 0×/);
  const ok = await mutants.load(url, {}, fake('  void consume(session);\n  // c\n  return session;\n'));
  assert.match(String(ok.source), /void consume\(session\);\n  refreshContextUsage\(wsId\);\n  \/\/ c/);
  const other = await mutants.load('file:///x/src/main/other.ts', {}, fake('nothing here'));
  assert.equal(String(other.source), 'nothing here', 'only agent-sdk.ts is mutated');
  await assert.rejects(() => mutants.initialize({ mutant: 'no-such-mutant' }), /unknown mutant/);
  await mutants.initialize({ mutant: null });
});

// ── process census ──────────────────────────────────────────────────────────

test('census classifies cli / keeper / mcp / hook / other', () => {
  const c = (...cmd: string[]) => proc.classify({ cmd });
  assert.equal(c('/home/u/.local/share/claude/versions/2.1.284', '--output-format', 'stream-json'), 'cli');
  assert.equal(c('claude', '-p'), 'cli');
  assert.equal(c('/usr/bin/node', '/h/.orchestra/bin/keeper.js', 'ws', '/s.sock'), 'keeper');
  assert.equal(c('/usr/bin/node', '/r/scripts/session-budget/fake-mcp-server.mjs', '--name', 'a'), 'mcp');
  assert.equal(c('/bin/bash', '/w/.orchestra/hook.sh'), 'hook');
  assert.equal(c('sleep', '5'), 'other');
});

test('census RSS is page-size independent: this process reads within 25% of Node\'s own memoryUsage().rss', () => {
  const me = proc.snapshotProcs().find((p: any) => p.pid === process.pid);
  const truth = process.memoryUsage().rss / 1024; // kB, from the kernel via libuv — independent of /proc parsing here
  assert.ok(me && me.rssKB > 0, 'own RSS must be readable and non-zero');
  assert.ok(Math.abs(me.rssKB - truth) / truth < 0.25, `census says ${me.rssKB} kB, memoryUsage says ${Math.round(truth)} kB`);
});

test('census (subtree mode) counts a child of this process and stops counting it once it dies', async () => {
  const before = proc.census({ pidns: false }).total;
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const during = proc.census({ pidns: false });
    assert.equal(during.total, before + 1);
    assert.ok(during.procs.some((p: any) => p.pid === child.pid && p.kind === 'other'));
  } finally { child.kill('SIGKILL'); }
  await new Promise((r) => child.once('exit', r));
  assert.equal(proc.census({ pidns: false }).total, before);
});

// ── optional real-API smoke (#208): the FLAG PATH, proven against the FAKE API only (D6) ────────────
// Every arm passes --api-base <fake>, so even a guard mutated away can only ever reach the fake API
// (never api.anthropic.com): a red here is observable as a nonzero fake counter, and costs nothing.

async function runSmoke(fake: { url: string; proxyUrl: string }, args: string[]): Promise<{ rc: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [S('smoke-real.mjs'), ...args, '--api-base', fake.url], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HTTPS_PROXY: fake.proxyUrl, HTTP_PROXY: fake.proxyUrl, NO_PROXY: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const rc: number | null = await new Promise((r) => child.on('exit', (c) => r(c)));
  clearTimeout(kill);
  return { rc, out, err };
}

test('real-API smoke REFUSES without --real-api, without an explicit --config-dir, on a bad dir, on an unset key var — and touches nothing', async () => {
  const f = await api.startFakeApi();
  const cfg = scratch('smoke-cfg');
  try {
    const cases: Array<[string, string[], RegExp]> = [
      ['no --real-api', ['--config-dir', cfg], /opt-in; pass --real-api/],
      ['--real-api alone', ['--real-api'], /--config-dir <dir> is required/],
      ['--config-dir missing value', ['--real-api', '--config-dir', '--model', 'haiku'], /--config-dir <dir> is required/],
      ['--config-dir not a dir', ['--real-api', '--config-dir', path.join(cfg, 'nope')], /is not a directory/],
      ['--api-key-env unset', ['--real-api', '--config-dir', cfg, '--api-key-env', 'SB_SMOKE_SURELY_UNSET_VAR'], /unset or empty/],
    ];
    for (const [name, args, why] of cases) {
      const r = await runSmoke(f, args);
      assert.equal(r.rc, 2, `${name}: rc`);
      assert.match(r.err, why, name);
      assert.match(r.out, /^REAL-API-SMOKE: REFUSED$/m, name);
    }
    assert.equal(f.requests.length, 0, 'a refusal must not run the CLI at all (fake API saw a request)');
    assert.equal(f.egress.length, 0);
  } finally { await f.stop(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('real-API smoke flag path (hermetic: a STUB `claude`, fake API): cheap model, tiny turn, chosen account, base URL wired — the real-CLI arm is `smoke-flag-path` in test:session-budget', async () => {
  const f = await api.startFakeApi();
  const cfg = scratch('smoke-cfg');
  const bin = scratch('smoke-bin');
  const argvLog = path.join(bin, 'argv.json');
  // The stub records argv + the env it was handed, makes ONE request to $ANTHROPIC_BASE_URL, and speaks stream-json.
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), env: { base: process.env.ANTHROPIC_BASE_URL, cfg: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY, home: process.env.HOME, nonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC } }));
fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', body: JSON.stringify({ model: process.argv[process.argv.indexOf('--model') + 1], max_tokens: 1, stream: true, messages: [] }) }).then((r) => r.text()).then(() => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-stub' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }));
});
`, { mode: 0o755 });
  try {
    const child = spawn(process.execPath, [S('smoke-real.mjs'), '--real-api', '--config-dir', cfg, '--api-base', f.url], {
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HTTPS_PROXY: f.proxyUrl, HTTP_PROXY: f.proxyUrl, NO_PROXY: '127.0.0.1,localhost' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const rc: number | null = await new Promise((r) => child.on('close', (c) => r(c)));
    assert.equal(rc, 0, `${out}\n${err}`);
    assert.match(out, /^REAL-API-SMOKE: PASS$/m);
    const line = JSON.parse(out.split('\n')[0]);
    assert.equal(line.ok, true);
    assert.equal(line.mode, 'api-base');
    const seen = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
    const has = (flag: string, val?: string) => { const i = seen.argv.indexOf(flag); return i >= 0 && (val === undefined || seen.argv[i + 1] === val); };
    assert.ok(has('--model', 'haiku'), 'the cheap model alias');
    assert.ok(has('--tools', ''), 'no tools');
    assert.ok(has('--max-turns', '1'));
    assert.ok(has('--max-budget-usd', '0.05'), 'a hard cost cap');
    assert.ok(has('--no-session-persistence'));
    assert.ok(has('--strict-mcp-config') && has('--setting-sources', 'project'));
    assert.equal(seen.env.base, f.url, 'the base URL reached the CLI');
    assert.equal(seen.env.cfg, path.resolve(cfg), 'the CHOSEN account dir reached the CLI');
    assert.notEqual(seen.env.home, os.homedir(), 'HOME is scratch, not the invoker\'s');
    assert.match(seen.env.key, /fake-key-not-real/, 'api-base mode uses a dummy key, never an ambient one');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].type, 'model');
    assert.equal(f.requests[0].model, 'haiku');
    assert.equal(f.egress.length, 0);
  } finally { await f.stop(); fs.rmSync(cfg, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('real-API smoke with no `claude` installed fails CLEANLY (rc 1, REAL-API-SMOKE: FAIL), not with an unhandled spawn error', async () => {
  const f = await api.startFakeApi();
  const cfg = scratch('smoke-cfg');
  try {
    const child = spawn(process.execPath, [S('smoke-real.mjs'), '--real-api', '--config-dir', cfg, '--api-base', f.url], { env: { PATH: '/nonexistent-bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const rc: number | null = await new Promise((r) => child.on('close', (c) => r(c)));
    assert.equal(rc, 1);
    assert.match(out, /^REAL-API-SMOKE: FAIL$/m);
    assert.match(err, /could not run `claude`/);
    assert.doesNotMatch(err, /Unhandled 'error' event/);
  } finally { await f.stop(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

// ── F1 / F10: the harness refuses weak containment; the runner refuses to run without the live-dir list ──────

test('F1: runSessionArm is VOID (spawns nothing) when containment is weaker than net+pid namespaces', async () => {
  const harness = await import(S('harness.mjs'));
  for (const name of ['proxy-only', 'netns']) {
    const r = await harness.runSessionArm({ repo: REPO, arm: 'normal', containment: { name, prefix: [] } });
    assert.equal(r.void, true, name);
    assert.match(r.error, new RegExp(`containment is '${name}', not 'netns\\+pidns'`));
    assert.match(r.error, /SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT=1/);
    assert.equal(r.report, undefined);
  }
});

test('F10: session-runner FAILS CLOSED when cfg.live is absent or empty (never runs against an unchecked list)', async () => {
  const root = scratch('runner-live');
  try {
    for (const live of [undefined, []]) {
      const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', `${REPO}/scripts/.r2-register.mjs`, S('session-runner.mjs')], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SB_CONFIG: JSON.stringify({ REPO, root, arm: 'x', ...(live ? { live } : {}) }) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      const rc: number | null = await new Promise((r) => child.on('close', (c) => r(c)));
      assert.notEqual(rc, 0, `live=${JSON.stringify(live)}`);
      assert.match(err, /cfg\.live .* absent or empty/);
      assert.ok(!fs.existsSync(path.join(root, 'home')), 'nothing was created before the refusal');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── the driver's exit / terminator contract, hermetic (a shimmed `bwrap` that always fails; no `claude` needed) ──

test('F1/F6 end to end: with bwrap unusable the driver is VOID rc 3 by default; under the explicit opt-out the self-tests are SKIPPED and a partial run prints PARTIAL — never PASS', async () => {
  const shim = scratch('bwrap-shim');
  fs.writeFileSync(path.join(shim, 'bwrap'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const keeperBundle = path.join(REPO, 'dist-electron', 'keeper.js');
  const keeperBefore = fs.existsSync(keeperBundle) ? fs.statSync(keeperBundle).mtimeMs : null;
  const run = async (extraEnv: Record<string, string>) => {
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', S('run.mjs'), '--arm', 'census-selftest'], {
      // SESSION_BUDGET_SKIP_BUILD: never rebuild dist-electron/keeper.js from a unit test — keeper.test.ts runs in parallel and spawns it (F5)
      cwd: REPO, env: { PATH: `${shim}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: os.homedir(), SESSION_BUDGET_SKIP_BUILD: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const rc: number | null = await new Promise((r) => child.on('close', (c) => r(c)));
    return { rc, out };
  };
  try {
    const strict = await run({});
    assert.equal(strict.rc, 3, strict.out);
    assert.match(strict.out, /== arm census-selftest: VOID — containment is 'proxy-only', not 'netns\+pidns'/);
    assert.match(strict.out, /^SESSION-BUDGET: VOID$/m);
    const weak = await run({ SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT: '1' });
    assert.equal(weak.rc, 0, weak.out);
    assert.match(weak.out, /WEAK containment explicitly allowed/);
    assert.match(weak.out, /== arm census-selftest: SKIPPED — needs net\+pid namespaces/);
    assert.match(weak.out, /^SESSION-BUDGET: PARTIAL$/m, 'a --arm run is PARTIAL (the PASS-WEAK mapping is unit-tested on sessionBudgetTerminator)');
    assert.doesNotMatch(weak.out, /^SESSION-BUDGET: PASS(-WEAK)?$/m, 'a partial weak run must never print a PASS terminator');
    // F5 (round 2): this unit must NOT rebuild dist-electron/keeper.js — keeper.test.ts spawns it in parallel and a build leaves it 0 bytes for a moment
    const keeperAfter = fs.existsSync(keeperBundle) ? fs.statSync(keeperBundle).mtimeMs : null;
    assert.equal(keeperAfter, keeperBefore, 'the driver rebuilt the keeper bundle from a unit test');
  } finally { fs.rmSync(shim, { recursive: true, force: true }); }
});

// ── canary: the probe targets must NEVER be a real address ────────────────────────────────────────

test('canary targets are documentation-range addresses only (RFC 5737 192.0.2.0/24, RFC 3849 2001:db8::/32) — harmless even when containment is broken', async () => {
  assert.equal(canary.CANARY.v4, '192.0.2.1');
  assert.equal(canary.CANARY.v6, '2001:db8::1');
  assert.ok(/^192\.0\.2\.\d+$/.test(canary.CANARY.v4) && /^2001:db8:/i.test(canary.CANARY.v6));
  // and it returns the documented shape without throwing (host-independent; a short timeout keeps a routed host fast)
  const p = await canary.containmentCanary({ timeoutMs: 100 });
  assert.equal(typeof p.connect4, 'string');
  assert.equal(typeof p.connect6, 'string');
  assert.ok(Array.isArray(p.interfaces) && p.interfaces.length >= 1);
  assert.equal(typeof p.nonLoopbackRoutes, 'number');
});

// ── the arm table and the rules that judge an arm are PINNED (C1 gate survivors: unpinned minBurst / positive control) ──

const verdict = (id: string, actual: number, extra: object = {}) => ({ id, kind: 'budget', ok: false, actual, limit: 'at most 0', message: `BUDGET BROKEN ${id}: saw ${actual}`, ...extra });
const iv = (id: string, message: string) => ({ id, kind: 'instrument', ok: false, actual: null, limit: 'required', message });
const okJudge = { ok: true, void: false, verdicts: [{ id: 'x', kind: 'budget', ok: true, actual: 0, limit: 'at most 0', message: 'ok' }] };

test('arm table pins: every number that gives an arm its meaning is a LITERAL here', () => {
  const A = armsMod.ARMS;
  assert.deepEqual(Object.keys(A), ['normal', 'boot-context-read', 'slow-startup', 'traffic-knob-in-env', 'app-egress-new-host', 'containment-canary', 'census-selftest', 'smoke-flag-path']);
  assert.equal(A['boot-context-read'].minBurst, 50);
  assert.equal(A['boot-context-read'].mustBreak, 'session.beforeFirstReply.countTokensRequests');
  assert.deepEqual(A['slow-startup'].mustExercise, { host: 'api.anthropic.com:443', min: 4 });
  assert.equal(A['slow-startup'].profile.mcpInitDelayMs, 1200);
  assert.equal(A['slow-startup'].expect, 'pass');
  assert.equal(A['app-egress-new-host'].minBurst, 1);
  assert.equal(A['app-egress-new-host'].maxBurst, 1);
  assert.equal(A['app-egress-new-host'].mustBreak, 'session.beforeFirstReply.startupEgressAttempts.telemetry.example.invalid:443');
  assert.equal(A['traffic-knob-in-env'].mustName, 'DISABLE_TELEMETRY');
  assert.equal(A['containment-canary'].mustAbort, 'containment');
  assert.equal(A['containment-canary'].lieAboutContainment, true);
});

test('evaluateArm: the slow-startup positive control BITES while the arm is healthy (a run that never saw the retry proves nothing)', () => {
  const spec = armsMod.ARMS['slow-startup'];
  const at = (n: number) => armsMod.evaluateArm(spec, { report: { startupEgress: { 'api.anthropic.com:443': n } }, judgement: okJudge });
  assert.equal(at(4).asExpected, true);
  assert.equal(at(5).asExpected, true);
  const three = at(3);
  assert.equal(three.asExpected, false);
  assert.equal(three.bad, true);
  assert.match(three.why, /did not exercise the retry path \(saw 3 startup attempts at api\.anthropic\.com:443, need ≥ 4\) — it proves nothing/);
  assert.equal(armsMod.evaluateArm(spec, { report: {}, judgement: okJudge }).asExpected, false, 'no startupEgress at all is not exercise');
  // a plain pass arm has no control and needs no attempts
  assert.equal(armsMod.evaluateArm(armsMod.ARMS.normal, { report: { startupEgress: {} }, judgement: okJudge }).asExpected, true);
});

test('evaluateArm: must-FAIL arms — a large burst for boot-context-read, EXACTLY one attempt for the new host', () => {
  const boot = armsMod.ARMS['boot-context-read'];
  const b = (n: number | null) => armsMod.evaluateArm(boot, { report: {}, judgement: { ok: false, void: false, verdicts: n === null ? [] : [verdict(boot.mustBreak, n)] } });
  assert.equal(b(57).asExpected, true);
  assert.equal(b(50).asExpected, true);
  assert.equal(b(49).asExpected, false);
  assert.match(b(49).why, /burst below 50/);
  assert.equal(b(null).asExpected, false);
  assert.match(b(null).why, /to break but it held/);
  const app = armsMod.ARMS['app-egress-new-host'];
  const a = (n: number) => armsMod.evaluateArm(app, { report: {}, judgement: { ok: false, void: false, verdicts: [verdict(app.mustBreak, n)] } });
  assert.equal(a(1).asExpected, true);
  assert.equal(a(2).asExpected, false);
  assert.match(a(2).why, /2 attempts, expected exactly 1/);
});

test('evaluateArm: must-VOID arms name the instrument AND the knob; the canary arm must also have ABORTED before booting; an unexpected VOID on a pass arm counts as voided, not bad', () => {
  const knob = armsMod.ARMS['traffic-knob-in-env'];
  const voidJ = (id: string, msg: string) => ({ ok: false, void: true, verdicts: [iv(id, msg)] });
  assert.equal(armsMod.evaluateArm(knob, { report: {}, judgement: voidJ('instrument.productionEnv', 'INSTRUMENT VOID …: traffic-suppressing env set: DISABLE_TELEMETRY — …') }).asExpected, true);
  assert.equal(armsMod.evaluateArm(knob, { report: {}, judgement: voidJ('instrument.productionEnv', 'INSTRUMENT VOID …: set: DISABLE_AUTOUPDATER') }).asExpected, false, 'right instrument, wrong knob');
  assert.equal(armsMod.evaluateArm(knob, { report: {}, judgement: voidJ('instrument.runCompleted', 'INSTRUMENT VOID … DISABLE_TELEMETRY') }).asExpected, false, 'wrong instrument');
  const can = armsMod.ARMS['containment-canary'];
  const canJ = voidJ('instrument.containmentProven', 'INSTRUMENT VOID …: want connect=ENETUNREACH (v4 and v6) …');
  assert.equal(armsMod.evaluateArm(can, { report: {}, judgement: canJ, aborted: 'containment' }).asExpected, true);
  const late = armsMod.evaluateArm(can, { report: {}, judgement: canJ });
  assert.equal(late.asExpected, false, 'VOID after a full session ran is NOT the guard working');
  assert.match(late.why, /not aborted before booting/);
  // a pass arm that comes out VOID is an unexpected VOID (voided), not a budget failure
  const v = armsMod.evaluateArm(armsMod.ARMS.normal, { report: {}, judgement: voidJ('instrument.mcpServersConnected', 'INSTRUMENT VOID …') });
  assert.deepEqual({ asExpected: v.asExpected, voided: v.voided, bad: v.bad }, { asExpected: false, voided: true, bad: false });
  // and a pass arm whose budget broke is bad, not voided
  const br = armsMod.evaluateArm(armsMod.ARMS.normal, { report: {}, judgement: { ok: false, void: false, verdicts: [verdict('session.beforeFirstReply.modelRequests', 2)] } });
  assert.deepEqual({ asExpected: br.asExpected, voided: br.voided, bad: br.bad }, { asExpected: false, voided: false, bad: true });
});
