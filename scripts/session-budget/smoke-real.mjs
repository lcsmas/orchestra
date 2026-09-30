#!/usr/bin/env node
// OPTIONAL real-API smoke (#208): ONE tiny turn on a CHEAP model through the real `claude` CLI, on an account
// the caller CHOOSES — so it never eats the main quota. It is the only run in this suite that may reach the
// real API (D6), so it is opt-in twice: `--real-api` AND an explicit `--config-dir` (never a default).
//
//   node scripts/session-budget/smoke-real.mjs --real-api --config-dir ~/.claude-smoke [--model haiku]
//        [--api-key-env NAME] [--api-base URL] [--max-budget-usd 0.05]
//
// `--api-base URL` points the CLI at another endpoint INSTEAD of the real API (ANTHROPIC_BASE_URL) — how the
// flag path is proven against the fake API in src/main/session-budget-harness.test.ts. Without it, this
// script talks to api.anthropic.com. Prints one JSON line then `REAL-API-SMOKE: PASS|FAIL`; rc 0 iff PASS,
// 2 = refused (usage), 1 = ran and failed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const refuse = (why) => { console.error(`smoke-real: REFUSED — ${why}`); console.log('REAL-API-SMOKE: REFUSED'); process.exit(2); };

if (!flag('real-api')) refuse('the real-API smoke is opt-in; pass --real-api (and --config-dir <the account to bill>). Nothing was run.');
const configDir = opt('config-dir');
if (!configDir || configDir.startsWith('--')) refuse('--config-dir <dir> is required: name the account this turn is billed to (it never defaults, so it cannot eat the main quota by accident).');
if (!fs.existsSync(configDir) || !fs.statSync(configDir).isDirectory()) refuse(`--config-dir ${configDir} is not a directory.`);
const apiBase = opt('api-base');
const keyEnv = opt('api-key-env');
if (keyEnv && !process.env[keyEnv]) refuse(`--api-key-env ${keyEnv} names an env var that is unset or empty.`);
const model = opt('model', 'haiku');
const maxUsd = opt('max-budget-usd', '0.05');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'));
const env = {
  PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8', TERM: 'dumb',
  CLAUDE_CONFIG_DIR: path.resolve(configDir),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
};
for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) if (process.env[k]) env[k] = process.env[k];
if (keyEnv) env.ANTHROPIC_API_KEY = process.env[keyEnv];
if (apiBase) {
  env.ANTHROPIC_BASE_URL = apiBase;
  env.ANTHROPIC_API_KEY ??= 'sk-ant-api03-smoke-fake-key-not-real';
}
// The smallest turn that proves the round trip: no tools, no MCP, no project settings, nothing persisted.
const cliArgs = ['-p', 'Reply with the single word ok.', '--model', model, '--output-format', 'stream-json', '--verbose',
  '--max-turns', '1', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project',
  '--no-session-persistence', '--max-budget-usd', maxUsd];

const t0 = Date.now();
const child = spawn('claude', cliArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));
const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
const rc = await new Promise((r) => child.on('exit', (c) => r(c)));
clearTimeout(killer);
fs.rmSync(cwd, { recursive: true, force: true });

const evs = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const init = evs.find((e) => e.type === 'system' && e.subtype === 'init');
const result = evs.find((e) => e.type === 'result');
const ok = rc === 0 && !!result && result.is_error === false && typeof result.result === 'string' && result.result.length > 0;
console.log(JSON.stringify({
  ok, mode: apiBase ? 'api-base' : 'real', account: path.basename(path.resolve(configDir)), requestedModel: model,
  resolvedModel: init?.model ?? null, cliRc: rc, timeToResultMs: result ? Date.now() - t0 : null,
  usage: result?.usage ? { input: result.usage.input_tokens ?? null, output: result.usage.output_tokens ?? null } : null,
  costUsd: result?.total_cost_usd ?? null, ...(ok ? {} : { stderrTail: err.slice(-300), resultText: result?.result ?? null }),
}));
console.log(`REAL-API-SMOKE: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
