import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #384 — `orchestra peers` prints "ex-<previous>" beside the branch of a renamed workspace and NOTHING for one never
// renamed; a fleet with no renamed peer prints byte-identical to before. Drives the BUILT cli.js against a real
// Unix-socket HTTP stub answering `/peers` (async execFile: a sync one would block the loop the stub needs).
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

type Peer = Record<string, unknown>;
const peer = (id: string, branch: string, extra: Peer = {}): Peer => ({ id, branch, repo: 'orchestra', status: 'idle', ...extra });

async function peers(t: { after: (fn: () => void) => void }, list: Peer[], args: string[] = []): Promise<{ code: number; stdout: string; seen: unknown[] }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-peers-ex-'));
  const sock = path.join(dir, 's.sock');
  const seen: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, peers: list }));
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const env: Record<string, string> = { ...process.env, ORCHESTRA_HOME: dir, HOME: dir, ORCHESTRA_SOCK: sock, ORCHESTRA_WS_ID: 'caller-ws' };
  return await new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'peers', ...args], { env, encoding: 'utf8', timeout: 30_000 }, (err, stdout) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? -1) : 0, stdout, seen });
    });
  });
}

test('no renamed peer ⇒ NO `ex` column: the table is byte-identical to the pre-#384 layout', needsBuild, async (t) => {
  const r = await peers(t, [peer('aaaa1111', 'impl-a-1'), peer('bbbb2222', 'ops-b', { statusText: 'working' })]);
  assert.equal(r.code, 0);
  assert.equal(
    r.stdout,
    [
      'id        branch    repo       status  note',
      '--------  --------  ---------  ------  -------',
      'aaaa1111  impl-a-1  orchestra  idle',
      'bbbb2222  ops-b     orchestra  idle    working',
      '',
    ].join('\n'),
  );
  assert.doesNotMatch(r.stdout, /\bex\b|ex-/);
  assert.deepEqual(r.seen, [{ url: '/peers', body: { from: 'caller-ws', stats: false } }], 'control: the stub answered the real /peers call');
});

test('a renamed peer prints `ex-<previous>` in an `ex` column right after the branch; a never-renamed peer\'s cell is blank', needsBuild, async (t) => {
  const r = await peers(t, [peer('aaaa1111', 'impl-a-1', { formerBranch: 'lucky-willow' }), peer('bbbb2222', 'ops-b')]);
  const lines = r.stdout.trimEnd().split('\n');
  assert.deepEqual(lines[0].split(/\s+/), ['id', 'branch', 'ex', 'repo', 'status']);
  assert.deepEqual(lines[2].split(/\s+/), ['aaaa1111', 'impl-a-1', 'ex-lucky-willow', 'orchestra', 'idle']);
  assert.deepEqual(lines[3].split(/\s+/), ['bbbb2222', 'ops-b', 'orchestra', 'idle'], 'never renamed ⇒ nothing printed for it');
  // columns stay aligned: `repo` starts at the same offset on the header and on both rows
  const at = (l: string) => l.indexOf('orchestra') === -1 ? l.indexOf('repo') : l.indexOf('orchestra');
  assert.equal(at(lines[0]), at(lines[2]));
  assert.equal(at(lines[2]), at(lines[3]));
});

test('a long former name widens ONLY the ex column: id/branch/repo/status keep their offsets in every row', needsBuild, async (t) => {
  const long = 'impl-' + 'x'.repeat(70);
  const r = await peers(t, [peer('aaaa1111', 'impl-a-1', { formerBranch: long }), peer('bbbb2222', 'ops-b')]);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines[2].split(/\s+/)[2], `ex-${long}`, 'the former name is printed verbatim, never truncated');
  const col = (l: string, word: string) => l.indexOf(word);
  assert.equal(col(lines[0], 'branch'), col(lines[2], 'impl-a-1'), 'branch column starts at the same offset on header and row');
  assert.equal(col(lines[2], 'orchestra'), col(lines[0], 'repo'), 'repo column is aligned past the widened ex column');
  assert.equal(col(lines[3], 'orchestra'), col(lines[0], 'repo'), 'the never-renamed row is padded to the same repo offset');
});

test('--stats keeps the ex column beside the branch and the stats columns after status', needsBuild, async (t) => {
  const r = await peers(t, [peer('aaaa1111', 'impl-a-1', { formerBranch: 'old', diff: { files: 3, insertions: 10, deletions: 2 } })], ['--stats']);
  const lines = r.stdout.trimEnd().split('\n');
  assert.deepEqual(lines[0].split(/\s+/), ['id', 'branch', 'ex', 'repo', 'status', 'files', '+/-']);
  assert.deepEqual(lines[2].split(/\s+/), ['aaaa1111', 'impl-a-1', 'ex-old', 'orchestra', 'idle', '3', '+10/-2']);
});
