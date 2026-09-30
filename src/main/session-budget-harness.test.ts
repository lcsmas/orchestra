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

test('real-API smoke, flag path against the FAKE API: one tiny cheap-model turn, ok, nothing else', async () => {
  const f = await api.startFakeApi();
  const cfg = scratch('smoke-cfg');
  try {
    const r = await runSmoke(f, ['--real-api', '--config-dir', cfg]);
    assert.equal(r.rc, 0, `${r.out}\n${r.err}`);
    const line = JSON.parse(r.out.split('\n')[0]);
    assert.equal(line.ok, true);
    assert.equal(line.mode, 'api-base');
    assert.equal(line.requestedModel, 'haiku');
    assert.match(line.resolvedModel, /haiku/);
    assert.match(r.out, /^REAL-API-SMOKE: PASS$/m);
    const models = f.requests.filter((x: any) => x.type === 'model');
    assert.equal(f.requests.length, 1, 'exactly one request in total');
    assert.equal(models.length, 1);
    assert.match(models[0].model, /haiku/, 'the cheap model, not the account default');
    assert.equal(models[0].tools, 0, 'a tiny turn: no tools');
    assert.equal(f.egress.length, 0);
  } finally { await f.stop(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('census (pid-namespace mode) is EXACTLY the tree under the runner — not the namespace init, not the runner itself', async () => {
  const harness = await import(S('harness.mjs'));
  const c = harness.detectContainment();
  if (c.name !== 'netns+pidns') { console.log(`# note: host has no bwrap pid namespace (containment=${c.name}); pidns census branch not exercised here`); return; }
  const script = `const {census}=await import(${JSON.stringify(S('proc-census.mjs'))}); const {spawn}=await import('node:child_process');
    const k=spawn('sleep',['30'],{stdio:'ignore'}); await new Promise(r=>setTimeout(r,150));
    const c=census({pidns:true}); k.kill('SIGKILL'); console.log(JSON.stringify({total:c.total,other:c.byKind.other,pids:c.procs.map(p=>p.pid),self:process.pid}));`;
  const child = spawn(c.prefix[0], [...c.prefix.slice(1), process.execPath, '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => child.on('exit', r));
  const j = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(j.total, 1, `census counted ${JSON.stringify(j)} — must be just the one child`);
  assert.equal(j.other, 1);
  assert.ok(!j.pids.includes(j.self) && !j.pids.includes(1));
});
