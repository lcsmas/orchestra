// Seat 3 — #399 UPGRADE SURVIVOR, measured end to end with the REAL SDK host + the REAL `claude` CLI + a scripted FAKE Anthropic API (zero tokens), contained in bwrap --unshare-net.
// The CLI lists `mcp__browser__navigate` (an in-process SDK MCP server on the HOST). Phase A: the host has the server (positive control: the tool RUNS). Phase B: the host LOSES the server
// (what a re-attached `query()` of the upgraded app is: `sdkMcpTransports` has no `browser`), the CLI still lists the tool → the model calls it: what does the model get, how fast, does the turn finish?
// Phase C: the same session answers a plain turn (no restart needed). Usage: node us1.mjs <repo-with-node_modules> [--toolsearch]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const REPO = fs.realpathSync(process.argv[2] ?? '.');
const SB = path.join(REPO, 'scripts/session-budget');
const { startFakeApi } = await import(`${SB}/fake-anthropic-api.mjs`);
const SDK = path.join(fs.realpathSync(path.join(REPO, 'node_modules/@anthropic-ai/claude-agent-sdk')), 'sdk.mjs');
const { query, createSdkMcpServer, tool } = await import(SDK);
const zodPath = fs.realpathSync(path.join(REPO, 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js')).replace(/index\.js$/, 'index.js');
const { z } = await import(zodPath);
const base = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'us1-'));
const home = path.join(base, 'home'); const cfg = path.join(home, '.claude'); const repo = path.join(base, 'repo');
for (const d of [cfg, repo]) fs.mkdirSync(d, { recursive: true });
const liveHome = process.env.REAL_HOME ?? '';
for (const p of [home, cfg, repo]) if (!fs.realpathSync(p).startsWith(fs.realpathSync(base))) { console.log(`REFUSED: ${p} is outside the scratch base`); process.exit(3); }
if (liveHome && (path.resolve(cfg) === path.join(liveHome, '.claude'))) { console.log('REFUSED: config dir is the live one'); process.exit(3); }
const useToolSearch = process.argv.includes('--toolsearch');

let called = 0;
const server = createSdkMcpServer({ name: 'browser', version: '1.0.0', tools: [tool('navigate', 'Open a URL in the browser pane', { url: z.string() }, async (a) => { called++; return { content: [{ type: 'text', text: `navigated:${a.url}` }] }; })] });

const script = [];   // [{phase, at}] filled by the controller
let phase = 'A'; let step = 0;
const mainSeen = [];
const api = await startFakeApi({
  keepMessages: true, replyDelayMs: 50,
  onRequest: (rec) => { if (rec.messages && rec.messages.length > 6) rec.messages = rec.messages.slice(-2); },
  reply: (rec) => {
    if (!(rec.tools > 0)) return undefined;            // side calls (title generator) keep the canned reply
    const msgs = rec.messages ?? [];
    const last = [...msgs].reverse().find((m) => m.role !== 'system');   // this CLI appends role:system reminder entries after the tool_result
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const tr = blocks.find((b) => b.type === 'tool_result');
    mainSeen.push({ n: mainSeen.length, phase, t: Date.now(), lastRole: last?.role, toolResult: tr ? { is_error: !!tr.is_error, content: (typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)).slice(0, 400) } : null });
    if (false) console.error('[api-rec] ' + JSON.stringify({ model: rec.model, tools: rec.tools, stream: rec.stream, path: rec.path, msgs: msgs.map((m) => ({ role: m.role, c: (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 200) })) }));
    console.error(`[api] main#${mainSeen.length - 1} phase ${phase} msgs=${msgs.length} lastRole=${last?.role} blocks=${blocks.map((b) => b.type).join(',')} toolResult=${tr ? JSON.stringify({ e: !!tr.is_error, c: (typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)).slice(0, 160) }) : '-'}`);
    if (mainSeen.length > 14) { console.error('[api] RUNAWAY: >30 main requests — answering text only'); return { text: 'runaway stop' }; }
    if (tr) {
      // the result of a tool call we scripted: finish the turn with text
      return { text: `phase ${phase} done` };
    }
    if (phase === 'C') return { text: 'phase C plain answer' };
    if (useToolSearch && step === 0) { step = 1; return { toolUse: { name: 'ToolSearch', input: { query: 'select:mcp__browser__navigate', max_results: 1 } } }; }
    step = 0;
    return { toolUse: { name: 'mcp__browser__navigate', input: { url: `http://example.invalid/${phase}` } } };
  },
});
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-us1-fake-key-not-real', NO_PROXY: '127.0.0.1,localhost', DISABLE_AUTOUPDATER: '1' };
for (const k of ['ANTHROPIC_AUTH_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete env[k];

const resolvers = []; const results = [];
async function* prompts() { let i = 0; while (true) { const text = await new Promise((r) => resolvers.push(r)); if (text === null) return; yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }; i++; } }
const q = query({ prompt: prompts(), options: { cwd: repo, env, mcpServers: { browser: server }, allowedTools: ['mcp__browser__navigate', 'ToolSearch'], pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude'), includePartialMessages: false, settingSources: [] } });
const t0 = Date.now();
const turnWaiters = [];
(async () => { try { for await (const m of q) { if (m.type === 'result') { results.push({ t: Date.now() - t0, subtype: m.subtype, is_error: m.is_error, result: String(m.result ?? '').slice(0, 300) }); turnWaiters.shift()?.(); } if (m.type === 'system' && m.subtype === 'init') results.push({ init: { tools: (m.tools ?? []).filter((n) => /browser/.test(n)), mcp: m.mcp_servers } }); } } catch (e) { results.push({ pumpError: String(e?.message ?? e) }); turnWaiters.splice(0).forEach((w) => w()); } })();
async function turn(text, ph, maxMs = 120000) {
  phase = ph; const start = Date.now(); const w = new Promise((r) => turnWaiters.push(r));
  resolvers.shift()?.(text) ?? (await new Promise((r) => setTimeout(r, 200)), resolvers.shift()?.(text));
  const timer = new Promise((r) => setTimeout(() => r('TIMEOUT'), maxMs));
  const out = await Promise.race([w.then(() => 'done'), timer]);
  return { out, ms: Date.now() - start };
}
await new Promise((r) => setTimeout(r, 300));
const report = {};
report.A = await turn('PHASE-A call the tool', 'A'); report.A.called = called; report.A.mainSeen = mainSeen.filter((m) => m.phase === 'A').map(({ toolResult, lastRole }) => ({ lastRole, toolResult }));
const hasTransports = q.sdkMcpTransports instanceof Map;
report.hostTransportsBefore = hasTransports ? [...q.sdkMcpTransports.keys()] : 'NO sdkMcpTransports MAP ON THE QUERY (cannot simulate)';
if (!hasTransports) { console.log(JSON.stringify({ report, results }, null, 1)); process.exit(4); }
q.sdkMcpTransports.delete('browser');                  // the upgraded host: the re-attached query() has no `browser` server
report.hostTransportsAfter = [...q.sdkMcpTransports.keys()];
const calledBefore = called;
report.B = await turn('PHASE-B call the tool again', 'B', 150000); report.B.calledDelta = called - calledBefore; report.B.mainSeen = mainSeen.filter((m) => m.phase === 'B').map(({ toolResult, lastRole }) => ({ lastRole, toolResult }));
report.C = await turn('PHASE-C plain', 'C', 90000); report.C.mainSeen = mainSeen.filter((m) => m.phase === 'C').length;
resolvers.shift()?.(null);
try { q.close?.(); } catch {}
await api.stop();
console.log(JSON.stringify({ base, report, results }, null, 1));
process.exit(0);
