#!/usr/bin/env node
// #470 / ledger #471 D3: which `verified-fanout` does the REAL `claude` CLI load when a PERSONAL-level copy (<CLAUDE_CONFIG_DIR>/skills)
// and a PROJECT-level copy (<cwd>/.claude/skills) both exist? Real CLI against the LOCAL FAKE API (zero tokens), scratch HOME + config dir.
// Per arm it reads (a) which skill description the first request LISTS and (b) which BODY the model gets back when it calls the Skill tool.
//   node scripts/skill-precedence/measure-skill-precedence.mjs            # prints one JSON line + SKILL-PRECEDENCE: <verdict>
// Arms: personal-only and project-only are the positive controls (the instrument can see each side); `both` is the measurement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { startFakeApi } from '../session-budget/fake-anthropic-api.mjs';
import { assertScratch, liveDirs } from '../session-budget/scratch-guard.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-prec-'));
const live = liveDirs();
const skill = (who) => `---\nname: verified-fanout\ndescription: DESC-${who} marker description\n---\n\nBODY-${who} marker body\n`;
const markers = { descPersonal: 'DESC-PERSONAL', descProject: 'DESC-PROJECT', bodyPersonal: 'BODY-PERSONAL', bodyProject: 'BODY-PROJECT' };

async function arm(label, { personal, project }) {
  const home = path.join(root, label, 'home');
  const cfg = path.join(root, label, 'cfg');
  const cwd = path.join(root, label, 'proj');
  for (const [l, p] of [['HOME', home], ['CLAUDE_CONFIG_DIR', cfg], ['cwd', cwd]]) { fs.mkdirSync(p, { recursive: true }); assertScratch(l, p, root, live); }
  execFileSync('git', ['init', '-q', cwd]);
  if (personal) { fs.mkdirSync(path.join(cfg, 'skills', 'verified-fanout'), { recursive: true }); fs.writeFileSync(path.join(cfg, 'skills', 'verified-fanout', 'SKILL.md'), skill('PERSONAL')); }
  if (project) { fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'verified-fanout'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'verified-fanout', 'SKILL.md'), skill('PROJECT')); }
  let called = false;
  const api = await startFakeApi({
    markers,
    reply: (rec) => {
      if (rec.tools > 0 && !called) { called = true; return { toolUse: { name: 'Skill', input: { skill: 'verified-fanout' } } }; }
      return undefined;
    },
  });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TERM: 'dumb', CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-skill-precedence-fake-key-not-real', HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
  };
  const args = ['-p', 'Use the verified-fanout skill.', '--output-format', 'stream-json', '--verbose', '--max-turns', '3', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--dangerously-skip-permissions'];
  const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  const rc = await new Promise((r) => child.on('exit', (c) => r(c)));
  clearTimeout(killer);
  const main = api.requests.filter((r) => r.type === 'model' && r.tools > 0);
  const seen = (k) => main.some((r) => r.marks.includes(k));
  const res = { arm: label, rc, mainRequests: main.length, listedPersonal: seen('descPersonal'), listedProject: seen('descProject'), bodyPersonal: seen('bodyPersonal'), bodyProject: seen('bodyProject'), egress: api.egress.length, requests: api.requests.map((r) => `${r.method} ${r.path}`), ...(rc === 0 ? {} : { stderrTail: err.slice(-300), stdoutTail: out.slice(-300) }) };
  await api.stop();
  return res;
}

const arms = [await arm('personal-only', { personal: true }), await arm('project-only', { project: true }), await arm('both', { personal: true, project: true })];
fs.rmSync(root, { recursive: true, force: true });
const [p, j, b] = arms;
// Controls must each see ONLY their own side and the body must have come back; otherwise the instrument is blind and no verdict is given.
const controlsOk = p.listedPersonal && p.bodyPersonal && !p.listedProject && !p.bodyProject && j.listedProject && j.bodyProject && !j.listedPersonal && !j.bodyPersonal;
let verdict = 'UNVERIFIED';
if (controlsOk) {
  if (b.bodyPersonal && !b.bodyProject) verdict = 'PERSONAL-WINS';
  else if (b.bodyProject && !b.bodyPersonal) verdict = 'PROJECT-WINS';
  else if (b.bodyProject && b.bodyPersonal) verdict = 'BOTH-LOADED';
}
console.log(JSON.stringify({ cli: execFileSync('claude', ['--version']).toString().trim(), arms }));
console.log(`SKILL-PRECEDENCE: ${verdict}`);
process.exit(verdict === 'UNVERIFIED' ? 1 : 0);
