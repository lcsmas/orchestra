// #240 (C13) — the account-migration transcript move. Drives the REAL `moveProjectTranscripts` / `sameDir` on
// real dirs (node:fs only). The driven proof through the real `dispatchMigrateAccountRequest` (incl. bind mount and
// cross-filesystem EXDEV, which are host-dependent) lives in scripts/e2e-migrate-transcripts.mjs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moveProjectTranscripts, firstMismatch } from './transcript-move.ts';
import { sameDir } from './same-dir.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-c13-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => { const d = path.join(ROOT, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

const put = (p: string, body: string, mtimeSec: number): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  const t = new Date(mtimeSec * 1000);
  fs.utimesSync(p, t, t);
};
/** rel path → `F:size:sha:mtimeMs` / `D` / `L:target` — content AND mtime (`--continue` resumes the newest). */
const sig = (dir: string): Record<string, string> => {
  const o: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name); const r = rel ? `${rel}/${ent.name}` : ent.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) o[r] = `L:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { o[r] = 'D'; walk(p, r); }
      else o[r] = `F:${st.size}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12)}:${st.mtimeMs}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return o;
};
const body = (k: string, lines: number): string => Array.from({ length: lines }, (_, i) => JSON.stringify({ k, i, pad: 'x'.repeat(120) })).join('\n') + '\n';

/** A config dir holding `projects/<M>/` with 3 sessions (distinct mtimes) and a session subdir tree. */
function seed(cfg: string): string {
  const proj = path.join(cfg, 'projects', 'M');
  put(path.join(proj, 'a.jsonl'), body('a', 40), 1_756_000_000);
  put(path.join(proj, 'b.jsonl'), body('b', 90), 1_756_100_000);
  put(path.join(proj, 'c.jsonl'), body('c', 25), 1_756_200_000);
  put(path.join(proj, 'c', 'subagents', 'agent-1.jsonl'), body('s', 12), 1_756_200_100);
  put(path.join(proj, 'c', 'tool-results', 'r.txt'), 'result\n'.repeat(300), 1_756_200_200);
  return proj;
}
const isFile = (v: string): boolean => v.startsWith('F:');

// ---- sameDir (the shared identity helper) ---------------------------------------------------------------

test('sameDir: every spelling of one dir is the same dir', () => {
  const base = fresh();
  const real = path.join(base, '.claude');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(base, 'alias'));
  fs.symlinkSync(path.join(base, 'alias'), path.join(base, 'alias2')); // chain
  const spellings = [`${real}/`, `${real}//`, path.join(base, '.', '.claude'), path.join(base, 'x', '..', '.claude'), path.join(base, 'alias'), path.join(base, 'alias') + '/', path.join(base, 'alias2')];
  for (const s of spellings) assert.equal(sameDir(real, s), true, `expected same: ${s}`);
  for (const s of spellings) assert.equal(sameDir(s, real), true, `expected same (reversed): ${s}`);
});

test('sameDir: identical dev+inode with a DIFFERENT realpath (hard link — a bind mount is the dir analogue) is the same object', () => {
  const base = fresh();
  fs.writeFileSync(path.join(base, 'f'), 'x');
  fs.linkSync(path.join(base, 'f'), path.join(base, 'g'));
  assert.notEqual(fs.realpathSync(path.join(base, 'f')), fs.realpathSync(path.join(base, 'g')), 'control: realpaths differ');
  assert.equal(sameDir(path.join(base, 'f'), path.join(base, 'g')), true);
});

test('sameDir: look-alikes, children and a missing side are NOT the same', () => {
  const base = fresh();
  for (const d of ['.claude', '.claude-mc', '.claude/acct']) fs.mkdirSync(path.join(base, d), { recursive: true });
  fs.writeFileSync(path.join(base, 'f'), 'x');
  fs.writeFileSync(path.join(base, 'g'), 'x'); // same content, different file
  assert.equal(sameDir(path.join(base, '.claude'), path.join(base, '.claude-mc')), false);
  assert.equal(sameDir(path.join(base, '.claude'), path.join(base, '.claude/acct')), false);
  assert.equal(sameDir(path.join(base, 'f'), path.join(base, 'g')), false);
  assert.equal(sameDir(path.join(base, '.claude'), path.join(base, 'missing')), false);
  assert.equal(sameDir(path.join(base, 'missing'), path.join(base, '.claude')), false);
});

test('sameDir: two MISSING paths compare by resolved path only', () => {
  const base = fresh();
  assert.equal(sameDir(path.join(base, 'nope') + '/', path.join(base, 'nope')), true);
  assert.equal(sameDir(path.join(base, 'nope'), path.join(base, 'other')), false);
});

// ---- moveProjectTranscripts: the same dir, however spelled -----------------------------------------------

async function assertSurvives(srcCfg: string, dstCfg: string, why: string): Promise<void> {
  const proj = path.join(srcCfg, 'projects', 'M');
  const before = sig(proj);
  assert.ok(Object.values(before).filter(isFile).length >= 5, 'control: the source really holds transcripts');
  await moveProjectTranscripts(proj, path.join(dstCfg, 'projects', 'M'));
  assert.deepEqual(sig(proj), before, `${why}: transcripts must survive byte-identical (content + mtime)`);
}

test('same dir: trailing slash / dot segment / double slash on the destination — transcripts survive', async () => {
  for (const spell of [(d: string) => `${d}/`, (d: string) => `${d}//`, (d: string) => path.join(d, '..', path.basename(d)), (d: string) => `${path.dirname(d)}/./${path.basename(d)}/`]) {
    const cfg = path.join(fresh(), '.claude');
    seed(cfg);
    await assertSurvives(cfg, spell(cfg), `spelling ${spell(cfg)}`);
  }
});

test('same dir: symlink alias (and a chain) of the config dir — transcripts survive', async () => {
  const base = fresh();
  const cfg = path.join(base, '.claude');
  seed(cfg);
  fs.symlinkSync(cfg, path.join(base, 'alias'));
  fs.symlinkSync(path.join(base, 'alias'), path.join(base, 'alias2'));
  await assertSurvives(cfg, path.join(base, 'alias'), 'symlink alias');
  await assertSurvives(cfg, path.join(base, 'alias2'), 'symlink chain');
  await assertSurvives(path.join(base, 'alias'), cfg, 'alias as the SOURCE');
});

test('same dir: two DIFFERENT config dirs sharing one projects/ (symlink) — transcripts survive', async () => {
  const base = fresh();
  const a = path.join(base, '.claude-a'); const b = path.join(base, '.claude-b');
  seed(a);
  fs.mkdirSync(b);
  fs.symlinkSync(path.join(a, 'projects'), path.join(b, 'projects'));
  await assertSurvives(a, b, 'shared projects/');
});

test('same dir: the destination PROJECT dir is a symlink to the source project dir — transcripts survive', async () => {
  const base = fresh();
  const a = path.join(base, '.claude-a'); const b = path.join(base, '.claude-b');
  const proj = seed(a);
  fs.mkdirSync(path.join(b, 'projects'), { recursive: true });
  fs.symlinkSync(proj, path.join(b, 'projects', 'M'));
  await assertSurvives(a, b, 'project-dir symlink');
});

test('same file at entry level (dst entry is a hard link of the src entry): rejects, BOTH names keep the content', async () => {
  const base = fresh();
  const a = path.join(base, '.claude-a'); const b = path.join(base, '.claude-b');
  const proj = seed(a);
  const dstProj = path.join(b, 'projects', 'M');
  fs.mkdirSync(dstProj, { recursive: true });
  fs.linkSync(path.join(proj, 'a.jsonl'), path.join(dstProj, 'a.jsonl'));
  const before = sig(proj);
  await assert.rejects(moveProjectTranscripts(proj, dstProj));
  assert.deepEqual(sig(proj), before, 'source untouched');
  assert.equal(fs.readFileSync(path.join(dstProj, 'a.jsonl'), 'utf8'), body('a', 40), 'the shared inode was not truncated');
});

// ---- a genuinely different target still moves ------------------------------------------------------------

test('different dir: everything lands at the destination byte-identical (mtimes kept), source removed', async () => {
  const base = fresh();
  const a = path.join(base, '.claude'); const b = path.join(base, '.claude-b'); // prefix look-alike, distinct dir
  const proj = seed(a);
  const before = sig(proj);
  const dstProj = path.join(b, 'projects', 'M');
  await moveProjectTranscripts(proj, dstProj);
  assert.deepEqual(sig(dstProj), before, 'content + mtime + subtree identical at the destination');
  assert.equal(fs.existsSync(proj), false, 'source project dir removed after the verified copy');
  assert.equal(fs.existsSync(path.join(a, 'projects')), true, 'only the project dir is removed, not the config tree');
});

test('different dir: merges into a pre-existing destination project dir, leaving its other files alone', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  put(path.join(dstProj, 'other.jsonl'), 'keep me\n', 1_700_000_000);
  put(path.join(dstProj, 'c', 'extra.txt'), 'keep me too\n', 1_700_000_000);
  await moveProjectTranscripts(proj, dstProj);
  assert.equal(fs.readFileSync(path.join(dstProj, 'other.jsonl'), 'utf8'), 'keep me\n');
  assert.equal(fs.readFileSync(path.join(dstProj, 'c', 'extra.txt'), 'utf8'), 'keep me too\n');
  assert.equal(fs.readFileSync(path.join(dstProj, 'c', 'subagents', 'agent-1.jsonl'), 'utf8'), body('s', 12));
  assert.equal(fs.existsSync(proj), false);
});

test('missing or empty source project dir: no-op, destination not created', async () => {
  const base = fresh();
  await moveProjectTranscripts(path.join(base, 'A', 'projects', 'M'), path.join(base, 'B', 'projects', 'M'));
  fs.mkdirSync(path.join(base, 'A2', 'projects', 'M'), { recursive: true });
  await moveProjectTranscripts(path.join(base, 'A2', 'projects', 'M'), path.join(base, 'B2', 'projects', 'M'));
  assert.equal(fs.existsSync(path.join(base, 'B')), false);
  assert.equal(fs.existsSync(path.join(base, 'B2')), false);
});

// ---- failure leaves the source intact --------------------------------------------------------------------

test('copy failure mid-way (2nd of 4 entries unwritable): rejects, source FULLY intact, no orphan copy, dst pre-state untouched', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  put(path.join(dstProj, 'b.jsonl', 'precious.txt'), 'pre-existing dst content\n', 1_700_000_000); // a dir where b.jsonl must go
  const before = sig(proj);
  const dstBefore = sig(dstProj);
  await assert.rejects(moveProjectTranscripts(proj, dstProj));
  assert.deepEqual(sig(proj), before, 'every source entry still present, byte-identical');
  assert.equal(fs.existsSync(path.join(dstProj, 'a.jsonl')), false, 'the copy of entry 1 made by this call was removed again');
  assert.deepEqual(sig(dstProj), dstBefore, 'destination is exactly as it was');
});

test('a copy that silently truncates one file is caught by verification: rejects, source intact, our copies removed', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const before = sig(proj);
  const copy = async (from: string, to: string): Promise<void> => {
    fs.cpSync(from, to, { recursive: true });
    if (path.basename(from) === 'b.jsonl') fs.truncateSync(to, 100);
  };
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { copy }), /not verified.*b\.jsonl/);
  assert.deepEqual(sig(proj), before);
  assert.deepEqual(Object.keys(sig(dstProj)), [], 'no half-copy left at the destination');
});

test('a copy that flips bytes but keeps the SIZE is caught (hash, not just size)', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const before = sig(proj);
  const copy = async (from: string, to: string): Promise<void> => {
    fs.cpSync(from, to, { recursive: true });
    if (path.basename(from) === 'a.jsonl') { const b = fs.readFileSync(to); b[10] = b[10] ^ 0xff; fs.writeFileSync(to, b); }
  };
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { copy }), /not verified.*a\.jsonl/);
  assert.deepEqual(sig(proj), before);
});

test('a copy that "succeeds" without writing an entry, or drops a nested file, is caught (every file present)', async () => {
  for (const skip of ['b.jsonl', 'c']) {
    const base = fresh();
    const proj = seed(path.join(base, 'A'));
    const dstProj = path.join(base, 'B', 'projects', 'M');
    const before = sig(proj);
    const copy = async (from: string, to: string): Promise<void> => {
      if (path.basename(from) === skip) return; // "success" that copied nothing
      fs.cpSync(from, to, { recursive: true });
    };
    await assert.rejects(moveProjectTranscripts(proj, dstProj, { copy }), /not verified/);
    assert.deepEqual(sig(proj), before, `source intact (skipped ${skip})`);
  }
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const copy = async (from: string, to: string): Promise<void> => {
    fs.cpSync(from, to, { recursive: true });
    if (path.basename(from) === 'c') fs.rmSync(path.join(to, 'subagents', 'agent-1.jsonl'));
  };
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { copy }), /not verified.*subagents\/agent-1\.jsonl/);
  assert.equal(fs.existsSync(path.join(proj, 'c', 'subagents', 'agent-1.jsonl')), true);
});

test('removal is non-recursive on the dir: a file that appears in the source mid-move is never deleted', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const copy = async (from: string, to: string): Promise<void> => {
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    put(path.join(proj, 'late.jsonl'), 'written after readdir\n', 1_756_300_000);
  };
  await moveProjectTranscripts(proj, dstProj, { copy });
  assert.equal(fs.readFileSync(path.join(proj, 'late.jsonl'), 'utf8'), 'written after readdir\n', 'the late file survives');
  assert.deepEqual(fs.readdirSync(proj), ['late.jsonl'], 'only the verified entries were removed');
  assert.equal(fs.existsSync(path.join(dstProj, 'a.jsonl')), true);
});

test('firstMismatch: identical → null; extra nodes at the destination are fine; a differing/missing node is named', async () => {
  const base = fresh();
  put(path.join(base, 'f', 'x.txt'), 'one', 1);
  put(path.join(base, 't', 'x.txt'), 'one', 1);
  put(path.join(base, 't', 'extra.txt'), 'more', 1);
  assert.equal(await firstMismatch(path.join(base, 'f'), path.join(base, 't')), null);
  fs.writeFileSync(path.join(base, 't', 'x.txt'), 'two');
  assert.match((await firstMismatch(path.join(base, 'f'), path.join(base, 't'))) ?? '', /x\.txt/);
  fs.rmSync(path.join(base, 't', 'x.txt'));
  assert.match((await firstMismatch(path.join(base, 'f'), path.join(base, 't'))) ?? '', /MISSING/);
});

// ---- wiring (belt only — the driven proof is scripts/e2e-migrate-transcripts.mjs) ------------------------

test('wiring: workspaces.ts routes the move through moveProjectTranscripts and compares no config-dir strings', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'workspaces.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function moveWorkspaceTranscripts('), src.indexOf('export async function dispatchMigrateAccountRequest('));
  assert.ok(fn.length > 100 && fn.includes('moveProjectTranscripts('), 'the move goes through the identity-checked helper');
  assert.equal(/srcConfigDir\s*===?\s*dstConfigDir/.test(fn), false, 'no raw-string equality on the config dirs');
  assert.equal(/rm\(\s*srcDir/.test(fn), false, 'no unconditional rm of the source dir');
});
