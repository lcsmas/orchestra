import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #440 — `orchestra promote` / `orchestra demote` are gone, a role follows POSITION. The BUILT CLI against a RECORDING socket (a refusal must never
// reach it) and, for `whoami`, a stub host speaking the role fields the real `/whoami` returns. The host half (real store, real hooks socket, real generated
// skills) is `scripts/verify-roles-follow-position.mjs`; mutants `scripts/roles-position-mutants.mjs` (`pnpm run test:roles-position-mutants`).

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

interface Outcome { code: number; stdout: string; stderr: string; seen: { route: string }[] }

/** Run the built CLI against a socket that records every request and answers `reply`. */
async function drive(args: string[], reply: (route: string, body: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true })): Promise<Outcome> {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'orch-roles440-'));
  const sock = path.join(dir, 's.sock');
  const seen: { route: string }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ route: req.url ?? '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply(req.url ?? '', body)));
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  try {
    return await new Promise<Outcome>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, ORCHESTRA_SOCK: sock, ORCHESTRA_WS_ID: 'caller-1' }, timeout: 20000 }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number ?? -1) : 0, stdout, stderr, seen });
      });
    });
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const verb of ['promote', 'demote']) {
  test(`orchestra ${verb} <id>: refused (rc≠0), the text says roles follow position and names whoami + spawn, and NOTHING reaches the host`, needsBuild, async () => {
    for (const argv of [[verb, 'ws-1'], [verb], [verb, '$ORCHESTRA_WS_ID', '--no-restart']]) {
      const r = await drive(argv);
      assert.notEqual(r.code, 0, `${argv.join(' ')}: rc`);
      assert.match(r.stderr, /follows its position in the tree/, 'says roles follow position');
      assert.match(r.stderr, /orchestra whoami/, 'names whoami');
      assert.match(r.stderr, /orchestra spawn/, 'names spawn');
      assert.doesNotMatch(r.stdout + r.stderr, /Promoted|Demoted/, 'no success line');
      assert.deepEqual(r.seen, [], `${argv.join(' ')}: the refusal is answered before any socket call`);
    }
  });

  test(`orchestra ${verb} --help: says the verb is removed, never runs it`, needsBuild, async () => {
    const r = await drive([verb, '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /removed/i);
    assert.deepEqual(r.seen, []);
  });
}

test('orchestra --help lists both as removed (never as a way to make an orchestrator)', needsBuild, async () => {
  const r = await drive(['--help']);
  assert.match(r.stdout, /promote\s+Removed/);
  assert.match(r.stdout, /demote\s+Removed/);
});

const HOST = (extra: Record<string, unknown>) => (route: string) => (route === '/whoami' ? { ok: true, id: 'caller-1', name: 'n', branch: 'b', kind: 'worktree', parentId: null, repoPath: '/r', baseBranch: 'main', ...extra } : { ok: false, error: 'unexpected route' });

test('whoami prints the role by position and the run, for a LEAD, an OPS and a worker (rows come from the host answer)', needsBuild, async () => {
  const lead = await drive(['whoami'], HOST({ role: 'LEAD', runId: 'caller-1' }));
  assert.match(lead.stdout, /^role {2,}LEAD$/m);
  assert.match(lead.stdout, /^run {2,}caller-1 \(owns it\)$/m);
  assert.doesNotMatch(lead.stdout, /^member of/m);
  const ops = await drive(['whoami'], HOST({ role: 'OPS', runId: 'caller-1', memberOfRunId: 'lead-9', parentId: 'lead-9' }));
  assert.match(ops.stdout, /^role {2,}OPS$/m);
  assert.match(ops.stdout, /^run {2,}caller-1 \(owns it\)$/m);
  assert.match(ops.stdout, /^member of {2,}lead-9$/m);
  assert.match(ops.stdout, /^parent {2,}lead-9$/m, 'the `parent` row the field-guide hook reads is kept');
  const worker = await drive(['whoami'], HOST({ role: 'worker', runId: 'ops-5', parentId: 'ops-5' }));
  assert.match(worker.stdout, /^role {2,}worker$/m);
  assert.match(worker.stdout, /^run {2,}ops-5 \(member: owned by its parent\)$/m);
  assert.doesNotMatch(worker.stdout, /^member of/m);
  for (const r of [lead, ops, worker]) assert.doesNotMatch(r.stdout, /^orchestrator /m, 'the old yes/no orchestrator row is gone');
});

test('whoami against a host that does not report a role says so, never invents one', needsBuild, async () => {
  const r = await drive(['whoami'], HOST({}));
  assert.match(r.stdout, /^role {2,}\(not reported\)$/m);
});

// ── source pins: the removals are structural, so a re-added verb / route / flag read goes red here (mutants: scripts/roles-position-mutants.mjs) ──
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const codeLines = (text: string): string[] => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

test('#440 — no promote/demote dispatcher, socket route, IPC channel or preload bridge is left', () => {
  const ws = src('src/main/workspaces.ts');
  assert.doesNotMatch(ws, /export async function dispatch(Promote|Demote)Request|startRunForPromoted/, 'workspaces.ts: the dispatchers and their helpers are gone');
  assert.doesNotMatch(src('src/main/hooks-server.ts'), /route === '\/(promote|demote)'/, 'hooks-server: no /promote or /demote route');
  for (const f of ['src/main/api-handlers.ts', 'src/shared/ipc.ts', 'src/preload/index.ts']) assert.doesNotMatch(src(f), /(promote|demote)Workspace|workspaces:(promote|demote)/, `${f}: no promote/demote IPC`);
});

test('#440 — the generated skills, the standing-role reminder and every brief carry NO promote step', () => {
  const offenders: string[] = [];
  for (const f of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, f);
    // the CLI's own refusal text (`orchestra ${verb} is gone`) is the one place the verbs are named
    if (rel === 'src/cli/help.ts') continue;
    codeLines(readFileSync(f, 'utf8')).forEach((l, i) => { if (/orchestra (promote|demote)\b|\bpromote <|\/promote\b/.test(l)) offenders.push(`${rel}:${i + 1}: ${l.trim().slice(0, 80)}`); });
  }
  assert.deepEqual(offenders, []);
  const ws = src('src/main/workspaces.ts');
  assert.doesNotMatch(ws.slice(ws.indexOf('const WORKSPACE_ADMIN_SKILL')), /^## Promote a workspace/m, 'the admin skill has no promote section');
  assert.match(ws, /## Roles follow position/, 'control: the replacement section is there (the instrument reads the right text)');
});

test('#440 — whoami: the host answer carries role/run by position (roleOf), not a coordinates() yes/no', () => {
  const body = src('src/main/workspaces.ts');
  const who = body.slice(body.indexOf('export function dispatchWhoamiRequest('));
  assert.match(who, /role: roleOf\(ws, lookup\),/);
  assert.match(who, /runId: runIdOf\(ws, lookup\),/);
  assert.match(who, /\.\.\.\(coordinates\(ws\) && memberRunOf\(ws, lookup\) \? \{ memberOfRunId: memberRunOf\(ws, lookup\)! \} : \{\}\),/);
  assert.doesNotMatch(who.slice(0, who.indexOf('\n}\n')), /orchestrator: coordinates/);
});

test('#440 — the capability flag is gone from the model; only the store load migrates it (→ ownsRun, key dropped)', () => {
  assert.doesNotMatch(src('src/shared/types.ts'), /^\s*canOrchestrate\??:/m, 'Workspace has no canOrchestrate field');
  const store = src('src/main/store.ts');
  assert.match(store, /legacy\.canOrchestrate === true \|\| parentsOfSomeone\.has\(ws\.id\)/, 'the migration maps the flag onto ownsRun');
  assert.match(store, /delete legacy\.canOrchestrate;/, 'and drops the key');
  const cli = src('src/cli/index.ts');
  assert.doesNotMatch(cli, /canOrchestrate/, 'the CLI offline path no longer reads the flag');
  assert.match(cli, /ownsRun: w\.ownsRun === true,/, 'the offline marshal reads ownsRun only');
  for (const f of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, f);
    if (rel === 'src/main/store.ts') continue;
    assert.doesNotMatch(codeLines(readFileSync(f, 'utf8')).join('\n'), /\bcanOrchestrate\b/, `${rel}: names the retired flag`);
  }
});
