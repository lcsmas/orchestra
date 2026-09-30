// #240 (C13) — the account-migration transcript move. Drives the REAL `moveProjectTranscripts` / `sameDir` on
// real dirs (node:fs only). The driven proof through the real `dispatchMigrateAccountRequest` (incl. bind mount and
// cross-filesystem EXDEV, which are host-dependent) lives in scripts/e2e-migrate-transcripts.mjs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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
  const rep = await moveProjectTranscripts(proj, path.join(dstCfg, 'projects', 'M'));
  assert.deepEqual(sig(proj), before, `${why}: transcripts must survive byte-identical (content + mtime)`);
  assert.deepEqual(rep.warnings, [], `${why}: a same-dir no-op is not a warning`);
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

test('same file at entry level (dst entry is a hard link of the src entry): left in BOTH places, never removed or truncated, with a warning', async () => {
  const base = fresh();
  const proj = seed(path.join(base, '.claude-a'));
  const dstProj = path.join(base, '.claude-b', 'projects', 'M');
  fs.mkdirSync(dstProj, { recursive: true });
  fs.linkSync(path.join(proj, 'a.jsonl'), path.join(dstProj, 'a.jsonl'));
  const rep = await moveProjectTranscripts(proj, dstProj);
  assert.equal(fs.readFileSync(path.join(proj, 'a.jsonl'), 'utf8'), body('a', 40), 'the shared inode is intact under the source name');
  assert.equal(fs.readFileSync(path.join(dstProj, 'a.jsonl'), 'utf8'), body('a', 40), 'and under the destination name');
  assert.match(rep.warnings.join('|'), /kept a\.jsonl in the source: it cannot be told apart/);
  assert.equal(fs.existsSync(path.join(dstProj, 'b.jsonl')), true, 'the other entries still move');
});

// ---- a genuinely different target still moves ------------------------------------------------------------

test('different dir (same filesystem): plain rename — byte-identical, mtimes AND inodes kept, source removed', async () => {
  const base = fresh();
  const a = path.join(base, '.claude'); const b = path.join(base, '.claude-b'); // prefix look-alike, distinct dir
  const proj = seed(a);
  const before = sig(proj);
  const inoBefore = fs.statSync(path.join(proj, 'a.jsonl')).ino;
  const dstProj = path.join(b, 'projects', 'M');
  const rep = await moveProjectTranscripts(proj, dstProj);
  assert.deepEqual(rep.warnings, []);
  assert.deepEqual(sig(dstProj), before, 'content + mtime + subtree identical at the destination');
  assert.equal(fs.statSync(path.join(dstProj, 'a.jsonl')).ino, inoBefore, 'same inode = a rename, not a copy');
  assert.equal(fs.existsSync(proj), false, 'source project dir removed');
  assert.equal(fs.existsSync(path.join(a, 'projects')), true, 'only the project dir is removed, not the config tree');
});

test('a writer holding the fd of a transcript keeps appending to it AFTER the move (rename follows the inode)', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const fd = fs.openSync(path.join(proj, 'a.jsonl'), 'a');
  await moveProjectTranscripts(proj, dstProj);
  fs.writeSync(fd, 'LATE-LINE\n');
  fs.closeSync(fd);
  assert.ok(fs.readFileSync(path.join(dstProj, 'a.jsonl'), 'utf8').endsWith('LATE-LINE\n'), 'the late append landed in the moved file');
  assert.equal(fs.existsSync(path.join(proj, 'a.jsonl')), false);
});

const exdev = async (): Promise<void> => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); };

test('cross-filesystem (rename says EXDEV): copy → verify → place; byte-identical incl. subtree and mtimes; source removed', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const before = sig(proj);
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const rep = await moveProjectTranscripts(proj, dstProj, { rename: exdev });
  assert.deepEqual(rep.warnings, []);
  assert.deepEqual(sig(dstProj), before);
  assert.equal(fs.existsSync(proj), false);
  assert.deepEqual(fs.readdirSync(dstProj).filter((n) => n.includes('.orchestra-mv-')), [], 'no tmp leftovers');
});

test('EXDEV on the 3rd rename: what was renamed is put back, then the copy path moves everything', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const before = sig(proj);
  const dstProj = path.join(base, 'B', 'projects', 'M');
  let n = 0;
  const flaky = async (f: string, t: string): Promise<void> => { if (++n === 3) await exdev(); await fsp.rename(f, t); };
  await moveProjectTranscripts(proj, dstProj, { rename: flaky });
  assert.deepEqual(sig(dstProj), before);
  assert.equal(fs.existsSync(proj), false);
});

test('merges nothing into a pre-existing destination: an IDENTICAL entry already there is a duplicate (source dropped), a DIFFERENT one is never overwritten', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  put(path.join(dstProj, 'other.jsonl'), 'keep me\n', 1_700_000_000);
  put(path.join(dstProj, 'a.jsonl'), body('a', 40), 1_756_000_000); // identical to the source's
  put(path.join(dstProj, 'b.jsonl'), 'DST-HAS-A-DIFFERENT-CONVERSATION\n', 1_756_999_999); // different + newer
  const dstB = fs.readFileSync(path.join(dstProj, 'b.jsonl'));
  const srcB = fs.readFileSync(path.join(proj, 'b.jsonl'));
  const rep = await moveProjectTranscripts(proj, dstProj);
  assert.deepEqual(fs.readFileSync(path.join(dstProj, 'b.jsonl')), dstB, 'the destination b.jsonl is untouched');
  assert.deepEqual(fs.readFileSync(path.join(proj, 'b.jsonl')), srcB, 'the source b.jsonl is kept');
  assert.equal(rep.warnings.length, 1);
  assert.match(rep.warnings[0], /kept b\.jsonl in the source.*different b\.jsonl/);
  assert.equal(fs.existsSync(path.join(proj, 'a.jsonl')), false, 'the identical duplicate was dropped from the source');
  assert.equal(fs.readFileSync(path.join(dstProj, 'other.jsonl'), 'utf8'), 'keep me\n');
  assert.equal(fs.existsSync(path.join(dstProj, 'c.jsonl')), true, 'the remaining entries moved');
  assert.deepEqual(fs.readdirSync(proj), ['b.jsonl'], 'source dir kept because it still holds the refused entry');
});

test('the copy path never overwrites either: a different destination entry survives byte-identical', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  put(path.join(dstProj, 'c', 'extra.txt'), 'keep me too\n', 1_700_000_000); // a `c` session dir that differs from the source's
  const dstBefore = sig(dstProj);
  const rep = await moveProjectTranscripts(proj, dstProj, { rename: exdev });
  assert.match(rep.warnings.join('|'), /kept c in the source/);
  assert.equal(fs.readFileSync(path.join(dstProj, 'c', 'extra.txt'), 'utf8'), 'keep me too\n');
  assert.equal(fs.existsSync(path.join(dstProj, 'c', 'subagents')), false, 'nothing merged into the different dir');
  for (const k of Object.keys(dstBefore)) assert.ok(k in sig(dstProj), `pre-existing ${k} still there`);
  assert.equal(fs.existsSync(path.join(proj, 'c', 'subagents', 'agent-1.jsonl')), true, 'the refused entry stays in the source');
});

test('missing or empty source project dir: no-op, destination not created, no warning', async () => {
  const base = fresh();
  const r1 = await moveProjectTranscripts(path.join(base, 'A', 'projects', 'M'), path.join(base, 'B', 'projects', 'M'));
  fs.mkdirSync(path.join(base, 'A2', 'projects', 'M'), { recursive: true });
  const r2 = await moveProjectTranscripts(path.join(base, 'A2', 'projects', 'M'), path.join(base, 'B2', 'projects', 'M'));
  assert.deepEqual([r1.warnings, r2.warnings], [[], []]);
  assert.equal(fs.existsSync(path.join(base, 'B')), false);
  assert.equal(fs.existsSync(path.join(base, 'B2')), false);
});

// ---- failure leaves the source intact --------------------------------------------------------------------

test('rename failing on the 3rd entry: rejects, everything renamed so far is put back — source FULLY intact, destination empty', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const before = sig(proj);
  const dstProj = path.join(base, 'B', 'projects', 'M');
  let n = 0;
  const failing = async (f: string, t: string): Promise<void> => { if (++n === 3) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); await fsp.rename(f, t); };
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { rename: failing }), /EACCES/);
  assert.deepEqual(sig(proj), before, 'every source entry back, byte-identical (content + mtime)');
  assert.deepEqual(Object.keys(sig(dstProj)), [], 'nothing left at the destination');
});

test('the copy path writes to a TMP name beside the destination and only then renames into place (never the final name)', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const seen: string[] = [];
  const copy = async (f: string, t: string): Promise<void> => { seen.push(path.basename(t)); fs.cpSync(f, t, { recursive: true, preserveTimestamps: true }); };
  await moveProjectTranscripts(proj, dstProj, { rename: exdev, copy });
  assert.equal(seen.length, 4);
  assert.ok(seen.every((n) => /\.orchestra-mv-/.test(n)), `every copy target is a tmp name: ${seen}`);
  assert.deepEqual(fs.readdirSync(dstProj).sort(), ['a.jsonl', 'b.jsonl', 'c', 'c.jsonl'], 'and they were renamed into place');
});

test('copy failing on the 2nd entry: rejects, source intact, our tmp copies removed, pre-existing destination files untouched', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const before = sig(proj);
  const dstProj = path.join(base, 'B', 'projects', 'M');
  put(path.join(dstProj, 'other.jsonl'), 'keep me\n', 1_700_000_000);
  const dstBefore = sig(dstProj);
  let n = 0;
  const copy = async (f: string, t: string): Promise<void> => { if (++n === 2) throw new Error('ENOSPC: no space left'); fs.cpSync(f, t, { recursive: true }); };
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { rename: exdev, copy }), /ENOSPC/);
  assert.deepEqual(sig(proj), before);
  assert.deepEqual(sig(dstProj), dstBefore, 'destination exactly as it was');
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
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { rename: exdev, copy }), /not verified.*b\.jsonl/);
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
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { rename: exdev, copy }), /not verified.*a\.jsonl/);
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
    await assert.rejects(moveProjectTranscripts(proj, dstProj, { rename: exdev, copy }), /not verified/);
    assert.deepEqual(sig(proj), before, `source intact (skipped ${skip})`);
  }
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const copy = async (from: string, to: string): Promise<void> => {
    fs.cpSync(from, to, { recursive: true });
    if (path.basename(from) === 'c') fs.rmSync(path.join(to, 'subagents', 'agent-1.jsonl'));
  };
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { rename: exdev, copy }), /not verified.*subagents\/agent-1\.jsonl/);
  assert.equal(fs.existsSync(path.join(proj, 'c', 'subagents', 'agent-1.jsonl')), true);
});

test('a destination entry that APPEARS during the copy is never overwritten: rejects, source intact, that entry untouched, our tmp copies removed', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const before = sig(proj);
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const copy = async (f: string, t: string): Promise<void> => {
    fs.cpSync(f, t, { recursive: true, preserveTimestamps: true });
    if (path.basename(f) === 'a.jsonl') put(path.join(dstProj, 'a.jsonl'), 'CREATED-BY-SOMEONE-ELSE\n', 1_700_000_000); // lands between plan and placement
  };
  await assert.rejects(moveProjectTranscripts(proj, dstProj, { rename: exdev, copy }), /appeared during the move/);
  assert.deepEqual(sig(proj), before);
  assert.equal(fs.readFileSync(path.join(dstProj, 'a.jsonl'), 'utf8'), 'CREATED-BY-SOMEONE-ELSE\n', 'not overwritten, not removed');
  assert.deepEqual(fs.readdirSync(dstProj).filter((n) => n.includes('.orchestra-mv-')), [], 'our tmp copies are gone');
});

test('a source entry that CHANGES after it was read (writer still alive) is kept, with a warning — the copy is stale', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const copy = async (from: string, to: string): Promise<void> => {
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    if (path.basename(from) === 'b.jsonl') { const t = new Date(1_800_000_000 * 1000); fs.utimesSync(from, t, t); } // touched right after being copied
  };
  const rep = await moveProjectTranscripts(proj, dstProj, { rename: exdev, copy });
  assert.equal(fs.existsSync(path.join(proj, 'b.jsonl')), true, 'the changed source is NOT removed');
  assert.equal(fs.existsSync(path.join(dstProj, 'b.jsonl')), true);
  assert.match(rep.warnings.join('|'), /kept b\.jsonl in the source: it changed while it was being copied/);
  assert.equal(fs.existsSync(path.join(proj, 'a.jsonl')), false, 'unchanged entries are still removed');
});

test('removal is non-recursive on the dir: a file that appears in the source mid-move is never deleted', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const copy = async (from: string, to: string): Promise<void> => {
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    put(path.join(proj, 'late.jsonl'), 'written after readdir\n', 1_756_300_000);
  };
  await moveProjectTranscripts(proj, dstProj, { rename: exdev, copy });
  assert.equal(fs.readFileSync(path.join(proj, 'late.jsonl'), 'utf8'), 'written after readdir\n', 'the late file survives');
  assert.deepEqual(fs.readdirSync(proj), ['late.jsonl'], 'only the verified entries were removed');
  assert.equal(fs.existsSync(path.join(dstProj, 'a.jsonl')), true);
});

// ---- identity assertions (F5) -----------------------------------------------------------------------------

test('a filesystem that reports inode 0 is refused BEFORE anything moves', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const before = sig(proj);
  const lstatSeam = async (p: string, o: { bigint: true }): Promise<fs.BigIntStats> => {
    const st = await fsp.lstat(p, o);
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: 0n }) as fs.BigIntStats;
  };
  await assert.rejects(moveProjectTranscripts(proj, path.join(base, 'B', 'projects', 'M'), { lstat: lstatSeam }), /cannot tell .* from .*no stable inode/);
  assert.deepEqual(sig(proj), before);
});

test('a source entry that turns out to be the SAME object as its destination copy is never removed', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  let armed = false;
  const lstatSeam = async (p: string, o: { bigint: true }): Promise<fs.BigIntStats> =>
    fsp.lstat(armed && p === path.join(proj, 'a.jsonl') ? path.join(dstProj, 'a.jsonl') : p, o); // from-side of a.jsonl now aliases its copy
  const copy = async (f: string, t: string): Promise<void> => { fs.cpSync(f, t, { recursive: true, preserveTimestamps: true }); if (path.basename(f) === 'c.jsonl') armed = true; };
  const rep = await moveProjectTranscripts(proj, dstProj, { rename: exdev, copy, lstat: lstatSeam });
  assert.equal(fs.existsSync(path.join(proj, 'a.jsonl')), true, 'not removed');
  assert.match(rep.warnings.join('|'), /kept a\.jsonl in the source: it cannot be told apart/);
  assert.equal(fs.existsSync(path.join(proj, 'b.jsonl')), false, 'others still removed');
});

// ---- F4: failures are reported, not swallowed --------------------------------------------------------------

test('a source entry that cannot be removed after the verified copy → a warning naming it (not silent), history safe at the destination', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const copy = async (f: string, t: string): Promise<void> => { fs.cpSync(f, t, { recursive: true, preserveTimestamps: true }); };
  // make ONE source entry unremovable: a dir whose parent stays writable but which holds an immutable-by-permission child
  fs.chmodSync(path.join(proj, 'c', 'tool-results'), 0o555);
  try {
    const rep = await moveProjectTranscripts(proj, dstProj, { rename: exdev, copy });
    assert.match(rep.warnings.join('|'), /could not remove .*\/c \(EACCES\)/);
    assert.equal(fs.readFileSync(path.join(dstProj, 'c', 'tool-results', 'r.txt'), 'utf8'), 'result\n'.repeat(300));
  } finally {
    fs.chmodSync(path.join(proj, 'c', 'tool-results'), 0o755);
  }
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

// ---- round 2 (#240 review r2): strand warnings, rollback warnings, leftover temp copies ----------------------

test('a file created in the source AFTER the listing is reported, not silently stranded (rmdir ENOTEMPTY)', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  let fired = false;
  const renameFn = async (f: string, t: string): Promise<void> => { await fsp.rename(f, t); if (!fired) { fired = true; put(path.join(proj, 'NEW-session.jsonl'), 'x'.repeat(500), 1_756_400_000); } };
  const rep = await moveProjectTranscripts(proj, dstProj, { rename: renameFn });
  assert.deepEqual(fs.readdirSync(proj), ['NEW-session.jsonl'], 'the new file is left where it is');
  assert.equal(rep.warnings.length, 1);
  assert.match(rep.warnings[0], /created after the move began.*NEW-session\.jsonl/);
});

test('rollback trouble travels on the thrown error: which entries are stranded at the destination', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  const dstProj = path.join(base, 'B', 'projects', 'M');
  let n = 0;
  const flaky = async (f: string, t: string): Promise<void> => {
    if (f.startsWith(dstProj)) { if (path.basename(f) === 'b.jsonl') throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } // put-back of b.jsonl fails
    else if (++n === 4) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); // the 4th forward rename fails
    await fsp.rename(f, t);
  };
  const err = await moveProjectTranscripts(proj, dstProj, { rename: flaky }).then(() => null, (e: Error & { warnings?: string[] }) => e);
  assert.ok(err, 'rejects');
  assert.match(err.message, /EIO/);
  assert.match(err.message, /could not put b\.jsonl back \(EACCES\)/, 'the stranded entry is named in the message the user sees');
  assert.equal(err.warnings?.length, 1);
  assert.equal(fs.existsSync(path.join(dstProj, 'b.jsonl')), true, 'and it really is stranded at the destination');
});

test('a leftover <name>.orchestra-mv-* temp copy is never carried onward: kept in the source with a warning', async () => {
  const base = fresh();
  const proj = seed(path.join(base, 'A'));
  put(path.join(proj, 's0.jsonl.orchestra-mv-4242-lq3x9k'), 'partial', 1_756_000_000);
  const dstProj = path.join(base, 'B', 'projects', 'M');
  const rep = await moveProjectTranscripts(proj, dstProj);
  assert.equal(fs.existsSync(path.join(dstProj, 's0.jsonl.orchestra-mv-4242-lq3x9k')), false, 'not moved');
  assert.equal(fs.existsSync(path.join(proj, 's0.jsonl.orchestra-mv-4242-lq3x9k')), true, 'left in place');
  assert.equal(rep.warnings.length, 1);
  assert.match(rep.warnings[0], /kept s0\.jsonl\.orchestra-mv-4242-lq3x9k in the source.*interrupted move/);
  assert.equal(fs.existsSync(path.join(dstProj, 'a.jsonl')), true, 'the real transcripts still move');
});

// ---- wiring (belt only — the driven proof is scripts/e2e-migrate-transcripts.mjs) ------------------------

test('wiring: workspaces.ts routes the move through moveProjectTranscripts, awaits the writer\'s death, and fences per workspace', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'workspaces.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function moveWorkspaceTranscripts('), src.indexOf('export async function dispatchMigrateAccountRequest('));
  assert.ok(fn.length > 100 && fn.includes('moveProjectTranscripts('), 'the move goes through the identity-checked helper');
  assert.equal(/srcConfigDir\s*===?\s*dstConfigDir/.test(fn), false, 'no raw-string equality on the config dirs');
  assert.equal(/rm\(\s*srcDir/.test(fn), false, 'no unconditional rm of the source dir');
  const disp = src.slice(src.indexOf('export async function dispatchMigrateAccountRequest('));
  const body = disp.slice(0, disp.indexOf('\nexport '));
  for (const [re, what] of [
    [/stuckPtyWriter\(id\)/, 'refuses while a previous stop left an agent process alive'],
    [/const fenceToken = beginMigration\(id\)/, 'per-workspace in-flight fence, holder-token'],
    [/endMigration\(id, fenceToken\)/, 'released by TOKEN (a stale call cannot drop a later call\'s fence)'],
    [/await sdkAwaitStart\(id,/, 'waits for an SDK session start already in flight'],
    [/await awaitPtyStarts\(id,/, 'waits for an agent PTY start already in flight'],
    [/await sdkStopIfLive\(id\)/, 'unconditional SDK stop (detached keeper too)'],
    [/await killKeeper\(id\)/, 'awaits the keeper/CLI death'],
    [/await stopPtyAndWait\(id\)/, 'awaits the PTY child exit'],
  ] as const) assert.ok(re.test(body), `dispatchMigrateAccountRequest: ${what}`);
  assert.equal(/sdkSessionLive\(id\)/.test(body), false, 'the SDK stop is not gated on an in-memory session (a detached keeper has none)');
  assert.ok(body.indexOf('await store.upsertWorkspace(updated)') < body.indexOf('releaseFence(); // re-pinned'), 'the fence drops only AFTER the re-pin');
  assert.ok(/finally \{\s*releaseFence\(\);/.test(body), 'and always in a finally');
  assert.equal((body.match(/endMigration\(/g) ?? []).length, 1, 'exactly ONE release site (inside the once-only releaseFence)');
  assert.ok(body.indexOf('await sdkAwaitStart(id,') < body.indexOf('const wasRunning = isRunning(id)'), 'in-flight starts settle BEFORE wasRunning is read');
  // the start fence at the two funnels an agent can start through
  const sdkSrc = fs.readFileSync(path.join(here, 'agent-sdk.ts'), 'utf8');
  assert.equal((sdkSrc.match(/isMigrating\(wsId\)/g) ?? []).length, 2, 'ensureSessionInner checks the fence at the top AND right before sessions.set');
  const ptySrc = fs.readFileSync(path.join(here, 'pty.ts'), 'utf8');
  assert.equal((ptySrc.match(/isMigrating\(opts\.workspaceId\)/g) ?? []).length, 2, 'startPty checks the fence at the top AND right after the transport is created');
});
