#!/usr/bin/env node
// #612 rig — the COMMAND of a no-agent workspace (stands in for `orchestra fanout run`, #605): every NA_POLL_MS it asks the host who it is (POST /identity with the
// env the host gave it), reads its lot (`orchestra check --ack-previous`) and runs the jobs the rig drops in NA_OUT/jobs — each job is an `orchestra …` argv run
// with THIS process's identity (so a verb is vouched, or refused, exactly as for a real command). Logs: ident.jsonl, reads.jsonl, jobs/<n>.out.json.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OUT = process.env.NA_OUT, CLI = process.env.NA_CLI, POLL = Number(process.env.NA_POLL_MS || 1000), CHECK_EVERY = Number(process.env.NA_CHECK_MS || 2000);
if (!OUT || !CLI) { console.error('NA_OUT / NA_CLI unset'); process.exit(2); }
const JOBS = path.join(OUT, 'jobs');
fs.mkdirSync(JOBS, { recursive: true });
const append = (f, o) => fs.appendFileSync(path.join(OUT, f), `${JSON.stringify(o)}\n`);
fs.writeFileSync(path.join(OUT, 'started.json'), JSON.stringify({ pid: process.pid, t: Date.now(), ws: process.env.ORCHESTRA_WS_ID, hasKey: !!process.env.ORCHESTRA_SESSION_KEY, sock: process.env.ORCHESTRA_SOCK, run: process.env.ORCHESTRA_RUN_ID, noClaudeConfig: !process.env.CLAUDE_CONFIG_DIR }));

function post(route, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const r = http.request({ socketPath: process.env.ORCHESTRA_SOCK, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 4000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ ok: false, code: 'bad-json' }); } });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ ok: false, code: 'unreachable', error: String(e.message).slice(0, 80) }));
    r.end(payload);
  });
}
const cli = (argv, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

let lastCheck = 0;
for (;;) {
  const t = Date.now();
  const id = await post('/identity', { id: process.env.ORCHESTRA_WS_ID, key: process.env.ORCHESTRA_SESSION_KEY });
  append('ident.jsonl', { t, ok: id.ok === true, code: id.ok ? 'ok' : id.code, runId: id.runId ?? null });
  if (t - lastCheck >= CHECK_EVERY) {
    lastCheck = t;
    const r = cli(['check', '--ack-previous']);
    let seqs = null, lot = null;
    try { const j = JSON.parse(r.stdout); seqs = (j.messages ?? []).map((m) => m.sequence); lot = j.lot ?? null; } catch { /* not JSON */ }
    append('reads.jsonl', { t, rc: r.code, lot, seqs, err: r.code ? `${r.stderr}`.slice(0, 160) : undefined });
  }
  for (const f of fs.readdirSync(JOBS).filter((n) => /^\d+\.json$/.test(n)).sort()) {
    const job = JSON.parse(fs.readFileSync(path.join(JOBS, f), 'utf8'));
    fs.renameSync(path.join(JOBS, f), path.join(JOBS, f.replace('.json', '.taken')));
    const r = cli(job.argv, job.env ?? {});
    fs.writeFileSync(path.join(JOBS, f.replace('.json', '.out.json')), JSON.stringify(r));
  }
  await new Promise((res) => setTimeout(res, POLL));
}
