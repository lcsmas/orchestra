// #240 — an account migration moves `<cfg>/projects/<mangled>/*` between config dirs. Master compared the config-dir STRINGS, so the
// same dir spelled differently was "moved" onto itself and `rm -r`'d. These arms run the SAME fixture through `legacyMove` (master's
// body, verbatim) — which must LOSE the history, proving the fixture can fail — and through `moveProjectTranscripts`, which must not.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cp, copyFile, mkdir, readdir, rename, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { moveProjectTranscripts } from './transcript-move.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-move-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string): string => { const d = path.join(root, `${label}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

const MANGLED = '-work-tree-x';
const NAMES = ['aaa.jsonl', 'bbb.jsonl', 'ccc.jsonl', 'ddd.jsonl', 'eee.jsonl', 'fff.jsonl'];
const SUB = 'ccc/subagents/agent-1.jsonl'; // newer CLIs keep a per-session dir next to the .jsonl

/** A project dir with 6 transcripts + 1 nested file, distinct bytes and distinct (old) mtimes. */
function seed(projectDir: string): void {
  fs.mkdirSync(projectDir, { recursive: true });
  NAMES.forEach((name, i) => {
    fs.writeFileSync(path.join(projectDir, name), `${name}\n`.repeat(50 + i * 7) + `{"i":${i}}\n`);
    const t = new Date(Date.UTC(2026, 0, 1 + i));
    fs.utimesSync(path.join(projectDir, name), t, t);
  });
  fs.mkdirSync(path.join(projectDir, path.dirname(SUB)), { recursive: true });
  fs.writeFileSync(path.join(projectDir, SUB), 'nested transcript\n'.repeat(20));
}
interface Snap { sha: string; mtimeMs: number }
function snap(projectDir: string): Map<string, Snap> {
  const out = new Map<string, Snap>();
  const walk = (p: string, rel: string): void => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(p, e.name), r);
      else out.set(r, { sha: createHash('sha256').update(fs.readFileSync(path.join(p, e.name))).digest('hex'), mtimeMs: fs.statSync(path.join(p, e.name)).mtimeMs });
    }
  };
  walk(projectDir, '');
  return out;
}
/** A config dir with its seeded project dir; returns [cfg, projectDir, baseline snapshot]. */
function seededConfig(label: string): [string, string, Map<string, Snap>] {
  const cfg = fresh(label);
  const pd = path.join(cfg, 'projects', MANGLED);
  seed(pd);
  return [cfg, pd, snap(pd)];
}
/** `mtimeTolMs`: `fs.cp(preserveTimestamps)` rounds a mtime to the ms; a rename keeps it exactly. */
const sameSnap = (a: Map<string, Snap>, b: Map<string, Snap>, mtimeTolMs = 0): void => {
  assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort(), 'same files');
  for (const [k, v] of a) { assert.equal(b.get(k)?.sha, v.sha, `${k} bytes`); assert.ok(Math.abs((b.get(k)?.mtimeMs ?? NaN) - v.mtimeMs) <= mtimeTolMs, `${k} mtime ${b.get(k)?.mtimeMs} vs ${v.mtimeMs}`); }
};
const cpTree = (f: string, t: string): Promise<void> => cp(f, t, { recursive: true, preserveTimestamps: true });
const rmrf = (p: string): Promise<void> => rm(p, { recursive: true, force: true });

/** master's `moveWorkspaceTranscripts` (workspaces.ts @011581b6), verbatim except `mangled` is passed in. */
async function legacyMove(mangled: string, srcConfigDir: string, dstConfigDir: string): Promise<void> {
  if (srcConfigDir === dstConfigDir) return;
  const srcDir = path.join(srcConfigDir, 'projects', mangled);
  const dstDir = path.join(dstConfigDir, 'projects', mangled);
  let entries: string[];
  try { entries = await readdir(srcDir); } catch { return; }
  if (entries.length === 0) return;
  await mkdir(dstDir, { recursive: true });
  for (const name of entries) {
    const from = path.join(srcDir, name);
    const to = path.join(dstDir, name);
    try { await rename(from, to); } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') { await copyFile(from, to); await rm(from, { force: true }); } else { throw err; }
    }
  }
  await rm(srcDir, { recursive: true, force: true }).catch(() => undefined);
}
const proj = (cfg: string): string => path.join(cfg, 'projects', MANGLED);

// ── the same dir spelled differently ─────────────────────────────────────────────────────────────────────
// Each spelling builds [srcCfg, dstCfg] naming ONE config dir twice.
const SPELLINGS: Record<string, (cfg: string) => string> = {
  'trailing slash': (cfg) => `${cfg}/`,
  'dot segments': (cfg) => `${cfg}/./`,
  'dotdot detour': (cfg) => path.join(cfg, '..', path.basename(cfg)) + '//',
  'relative path': (cfg) => path.relative(process.cwd(), cfg),
  'symlink alias': (cfg) => { const l = fresh('alias') + '/link'; fs.symlinkSync(cfg, l); return l; },
  'symlink to a symlink': (cfg) => { const a = fresh('alias') + '/a'; const b = fresh('alias') + '/b'; fs.symlinkSync(cfg, a); fs.symlinkSync(a, b); return b; },
};
for (const [label, spell] of Object.entries(SPELLINGS)) {
  test(`UNFIXED (master) loses the history when the target is the same dir as a ${label} — the fixture can fail`, async () => {
    const [cfg, pd] = seededConfig('legacy');
    await legacyMove(MANGLED, cfg, spell(cfg));
    assert.equal(fs.existsSync(pd), false, 'master removed the project dir');
    // a symlink/relative/slash alias of the SAME dir: the data is gone for good (string compare said "different")
    assert.equal(fs.existsSync(path.join(pd, NAMES[0]!)), false);
  });
  test(`${label}: the same dir is recognized — nothing moved, nothing removed, no warning`, async () => {
    const [cfg, pd, base] = seededConfig('same');
    const rep = await moveProjectTranscripts(proj(cfg), proj(spell(cfg)));
    assert.deepEqual(rep.warnings, []);
    sameSnap(base, snap(pd));
  });
}

test('a shared `projects/` (config dirs differ, `projects` is one symlinked dir): recognized at the project dir — nothing lost', async () => {
  const [cfgA, pd, base] = seededConfig('shared-a');
  const cfgB = fresh('shared-b');
  fs.symlinkSync(path.join(cfgA, 'projects'), path.join(cfgB, 'projects'));
  // master: cfgA !== cfgB as strings → rename onto itself, then rm -r the dir
  const [cfgL] = seededConfig('shared-legacy-a');
  const cfgLB = fresh('shared-legacy-b');
  fs.symlinkSync(path.join(cfgL, 'projects'), path.join(cfgLB, 'projects'));
  await legacyMove(MANGLED, cfgL, cfgLB);
  assert.equal(fs.existsSync(proj(cfgL)), false, 'control: master loses it');
  const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB));
  assert.deepEqual(rep.warnings, []);
  sameSnap(base, snap(pd));
});

test('the project dir itself symlinked to the other (per-project alias): recognized', async () => {
  const [cfgA, pd, base] = seededConfig('pa');
  const cfgB = fresh('pb');
  fs.mkdirSync(path.join(cfgB, 'projects'), { recursive: true });
  fs.symlinkSync(pd, proj(cfgB));
  const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB));
  assert.deepEqual(rep.warnings, []);
  sameSnap(base, snap(pd));
});

// ── a genuinely different target still moves ─────────────────────────────────────────────────────────────
test('a different config dir (same filesystem): everything moves — bytes and mtimes intact — and the source dir is removed', async () => {
  const [cfgA, pdA, base] = seededConfig('a');
  const cfgB = fresh('b');
  const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB));
  assert.deepEqual(rep.warnings, []);
  sameSnap(base, snap(proj(cfgB)));
  assert.equal(fs.existsSync(pdA), false, 'source project dir removed');
  assert.deepEqual(fs.readdirSync(proj(cfgB)).sort(), [...NAMES, 'ccc'].sort());
});

test('control: a missing / empty source is a quiet no-op (nothing is created or removed)', async () => {
  const cfgA = fresh('empty-a');
  const cfgB = fresh('empty-b');
  assert.deepEqual((await moveProjectTranscripts(proj(cfgA), proj(cfgB))).warnings, []);
  assert.equal(fs.existsSync(proj(cfgB)), false);
  fs.mkdirSync(proj(cfgA), { recursive: true });
  assert.deepEqual((await moveProjectTranscripts(proj(cfgA), proj(cfgB))).warnings, []);
  assert.equal(fs.existsSync(proj(cfgA)), true, 'an empty source is left alone, as on master');
  assert.equal(fs.existsSync(proj(cfgB)), false);
});

test('a destination entry of the same name is NEVER overwritten: the source entry is kept and a warning names it', async () => {
  const [cfgA, , base] = seededConfig('collide-a');
  const cfgB = fresh('collide-b');
  fs.mkdirSync(proj(cfgB), { recursive: true });
  fs.writeFileSync(path.join(proj(cfgB), 'bbb.jsonl'), 'DIFFERENT destination content\n');
  const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB));
  assert.equal(fs.readFileSync(path.join(proj(cfgB), 'bbb.jsonl'), 'utf8'), 'DIFFERENT destination content\n', 'destination untouched');
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(proj(cfgA), 'bbb.jsonl'))).digest('hex'), base.get('bbb.jsonl')!.sha, 'source entry kept');
  assert.ok(rep.warnings.some((w) => w.includes('bbb.jsonl')), `warning names it: ${rep.warnings}`);
  assert.equal(fs.existsSync(path.join(proj(cfgB), 'aaa.jsonl')), true, 'the other entries still moved');
});

// ── failures leave nothing deleted ───────────────────────────────────────────────────────────────────────
test('a rename that fails mid-way: what this call moved is put back — the source is whole, the destination holds nothing of it', async () => {
  const [cfgA, pdA, base] = seededConfig('fail-a');
  const cfgB = fresh('fail-b');
  let k = 0;
  await assert.rejects(moveProjectTranscripts(proj(cfgA), proj(cfgB), {
    rename: async (f, t) => { if (++k === 4) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); await rename(f, t); },
  }), /EIO: injected/);
  sameSnap(base, snap(pdA));
  assert.deepEqual(fs.existsSync(proj(cfgB)) ? fs.readdirSync(proj(cfgB)) : [], [], 'nothing left at the destination');
});

const exdev = async (): Promise<void> => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); };

test('cross-filesystem (EXDEV): copy → verify → place → remove: bytes + mtimes intact, no tmp copy left, source removed', async () => {
  const [cfgA, pdA, base] = seededConfig('x-a');
  const cfgB = fresh('x-b');
  const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB), { rename: exdev });
  assert.deepEqual(rep.warnings, []);
  sameSnap(base, snap(proj(cfgB)), 1);
  assert.equal(fs.existsSync(pdA), false);
  assert.ok(!fs.readdirSync(proj(cfgB)).some((f) => f.includes('.orchestra-mv-')), 'no tmp copy left');
});

test('EXDEV, copy fails on the 3rd entry: the source is untouched and no tmp / partial copy is left at the destination', async () => {
  const [cfgA, pdA, base] = seededConfig('xf-a');
  const cfgB = fresh('xf-b');
  let k = 0;
  await assert.rejects(moveProjectTranscripts(proj(cfgA), proj(cfgB), {
    rename: exdev,
    copy: async (f, t) => { if (++k === 3) { await writeFile(t, 'partial'); throw new Error('ENOSPC: injected'); } await cpTree(f, t); },
  }), /ENOSPC: injected/);
  sameSnap(base, snap(pdA));
  assert.deepEqual(fs.readdirSync(proj(cfgB)), [], 'destination clean');
});

test('EXDEV, a corrupt copy (truncated): verification refuses — the source is never removed', async () => {
  const [cfgA, pdA, base] = seededConfig('xc-a');
  const cfgB = fresh('xc-b');
  await assert.rejects(moveProjectTranscripts(proj(cfgA), proj(cfgB), {
    rename: exdev,
    copy: async (f, t) => { await cpTree(f, t); if (f.endsWith('ddd.jsonl')) await writeFile(t, (await readFile(f)).subarray(0, 40)); },
  }), /not verified \(ddd\.jsonl/);
  sameSnap(base, snap(pdA));
  assert.deepEqual(fs.readdirSync(proj(cfgB)), [], 'destination clean');
});

test('EXDEV, the source grows WHILE it is being copied (a live writer): verification refuses — source whole, destination clean', async () => {
  const [cfgA, pdA] = seededConfig('xw-a');
  const cfgB = fresh('xw-b');
  await assert.rejects(moveProjectTranscripts(proj(cfgA), proj(cfgB), {
    rename: exdev,
    copy: async (f, t) => { await cpTree(f, t); if (f.endsWith('eee.jsonl')) await appendFile(f, '{"late":"append"}\n'); },
  }), /not verified \(eee\.jsonl/);
  assert.equal(fs.readdirSync(pdA).length, NAMES.length + 1, 'every source entry still there');
  assert.deepEqual(fs.readdirSync(proj(cfgB)), []);
});

test('EXDEV, the source grows AFTER the copy was verified, before its removal: that entry is KEPT in the source, with a warning', async () => {
  const [cfgA, pdA] = seededConfig('xw2-a');
  const cfgB = fresh('xw2-b');
  const real = fs.promises.lstat;
  let appended = false;
  const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB), {
    rename: exdev,
    lstat: (async (p: string, o: { bigint: true }) => {
      if (!appended && p === path.join(pdA, 'eee.jsonl')) { appended = true; fs.appendFileSync(p, '{"late":"append"}\n'); } // the identity probe is the last step before the removal
      return real(p, o);
    }) as never,
  });
  assert.ok(appended, 'control: the late append happened');
  assert.ok(fs.readFileSync(path.join(pdA, 'eee.jsonl'), 'utf8').endsWith('{"late":"append"}\n'), 'the appended tail is still in the source');
  assert.equal(fs.existsSync(path.join(pdA, 'aaa.jsonl')), false, 'unchanged entries are removed');
  assert.ok(rep.warnings.some((w) => w.includes('eee.jsonl') && w.includes('changed')), `warned: ${rep.warnings}`);
});

test('EXDEV, a source that cannot be told apart from its copy (identity unknown / equal) is never removed', async () => {
  for (const mode of ['ino0', 'equal'] as const) {
    const [cfgA, pdA, base] = seededConfig(`xi-${mode}-a`);
    const cfgB = fresh(`xi-${mode}-b`);
    const real = fs.promises.lstat;
    const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB), {
      rename: exdev,
      lstat: (async (p: string, o: { bigint: true }) => {
        const st = await real(p, o);
        if (!p.includes(`${path.sep}projects${path.sep}${MANGLED}${path.sep}`)) return st; // the entries, not the project dirs
        return mode === 'ino0' ? { ...st, ino: 0n } : { ...st, dev: 7n, ino: 7n };
      }) as never,
    });
    sameSnap(base, snap(pdA));
    assert.ok(rep.warnings.some((w) => w.includes('cannot be told apart')), `${mode}: warned: ${rep.warnings}`);
  }
});

test('a file that appears in the source while it is being moved is never deleted (the dir goes by rmdir, not rm -r)', async () => {
  const [cfgA, pdA] = seededConfig('late-a');
  const cfgB = fresh('late-b');
  let k = 0;
  const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB), {
    rename: async (f, t) => { await rename(f, t); if (++k === 2) fs.writeFileSync(path.join(pdA, 'zzz-new-session.jsonl'), 'a session that started mid-move\n'); },
  });
  assert.equal(fs.readFileSync(path.join(pdA, 'zzz-new-session.jsonl'), 'utf8'), 'a session that started mid-move\n');
  assert.ok(rep.warnings.some((w) => w.includes('zzz-new-session.jsonl')), `warned: ${rep.warnings}`);
});

test('an unreadable source dir is reported, not swallowed (history stranded is said out loud)', async (t) => {
  if (process.getuid?.() === 0) return t.diagnostic('root reads everything: arm not applicable'); // a pass, not a skip
  const [cfgA, pdA] = seededConfig('perm-a');
  const cfgB = fresh('perm-b');
  fs.chmodSync(pdA, 0o000);
  try {
    const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB));
    assert.ok(rep.warnings.some((w) => w.includes('NOT moved')), `warned: ${rep.warnings}`);
  } finally { fs.chmodSync(pdA, 0o755); }
  assert.equal(fs.readdirSync(pdA).length, NAMES.length + 1);
});

// ── two movers of one dir ────────────────────────────────────────────────────────────────────────────────
test('two overlapping moves of one dir (deterministic interleave): the 2nd takes everything while the 1st is mid-way — nothing lost, nothing thrown', async () => {
  const [cfgA, , base] = seededConfig('c-a');
  const cfgB = fresh('c-b');
  let second: Promise<unknown> | undefined;
  let k = 0;
  const first = moveProjectTranscripts(proj(cfgA), proj(cfgB), {
    rename: async (f, t) => {
      if (++k === 2) second = moveProjectTranscripts(proj(cfgA), proj(cfgB)); // a whole 2nd mover runs INSIDE the 1st's loop
      if (k === 2) await second;
      await rename(f, t);
    },
  });
  await first;
  await second;
  sameSnap(base, snap(proj(cfgB)));
  assert.equal(fs.existsSync(proj(cfgA)), false);
});

test('a mover whose source dir was removed by a concurrent mover between its listing and its move answers quietly — nothing lost, nothing thrown', async () => {
  const [cfgA, , base] = seededConfig('v-a');
  const cfgB = fresh('v-b');
  const real = fs.promises.lstat;
  let first = true;
  const rep = await moveProjectTranscripts(proj(cfgA), proj(cfgB), {
    lstat: (async (p: string, o: { bigint: true }) => {
      if (first && p === proj(cfgA)) { first = false; await moveProjectTranscripts(proj(cfgA), proj(cfgB)); } // the OTHER mover runs to completion right here
      return real(p, o);
    }) as never,
  });
  assert.ok(!first, 'control: the other mover ran inside the window');
  assert.deepEqual(rep.warnings, []);
  sameSnap(base, snap(proj(cfgB)));
  assert.equal(fs.existsSync(proj(cfgA)), false);
});

test('two overlapping moves of one dir, 40 racing iterations: every file ends in exactly one place, bytes intact', async () => {
  for (let i = 0; i < 40; i++) {
    const [cfgA, , base] = seededConfig(`r-a${i}`);
    const cfgB = fresh(`r-b${i}`);
    const results = await Promise.allSettled([moveProjectTranscripts(proj(cfgA), proj(cfgB)), moveProjectTranscripts(proj(cfgA), proj(cfgB))]);
    for (const r of results) assert.equal(r.status, 'fulfilled', `iteration ${i}: ${r.status === 'rejected' ? r.reason : ''}`);
    sameSnap(base, snap(proj(cfgB)));
    assert.equal(fs.existsSync(proj(cfgA)), false, `iteration ${i}: source removed`);
  }
});
