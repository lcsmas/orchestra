// Pause canary (#258) — BUILD-LEVEL mutants of the PACKAGED app, to prove each drill instrument can say FAIL (ledger #281 G3 F2).
// The shipped bundles inside `resources/app.asar` are patched IN A COPY of the unpacked app (never the original): every edit is a SAME-LENGTH byte replacement of a unique anchor in a LIVE
// bundle (main.js + the chunks it requires + cli.js; a stale chunk is dead code — patching it would be a silent no-op), so the asar's offsets/header stay valid with no repack.
// The bundle is minified and its identifiers change with every build, so anchors are string literals or NAME-AGNOSTIC regexes (`\1` back-references). `expect` = the exact number of
// occurrences: a count mismatch is PATTERN-GONE (the bundle moved on) = the arm is VOID, never a silent green.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const lit = (find, replace, expect = 1) => {
  if (find.length !== replace.length) throw new Error(`mutant edit not same-length (${find.length} vs ${replace.length}): ${find.slice(0, 60)}`);
  return { re: new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to: () => replace, expect, label: find.slice(0, 60) };
};
const rx = (re, to, expect = 1) => ({ re: new RegExp(re.source, 'g'), to, expect, label: re.source.slice(0, 60) });

/** name → { desc, exercise (the drill that must go red), redden (the check ids that must go RED), edits: [{re, to(match) → same-length string, expect, label}] } */
export const MUTANTS = {
  // lost-work instrument: the pause snapshot's `git add -A` becomes a dry run → the ref is taken but holds no untracked / tracked-edit work
  'skip-snapshot': {
    desc: 'snapshot `git add -A` → `git add -n` (dry run): the pause ref misses the uncommitted + untracked work',
    exercise: 'dure', redden: ['bar:lost_work_is_zero'],
    edits: [lit('"add","-A","--ignore-errors","--",', '"add","-n","--ignore-errors","--",'), lit('"add","-A","--ignore-errors",`--pathspec-from-file=', '"add","-n","--ignore-errors",`--pathspec-from-file=')],
  },
  // hold instrument (Pause dure not held): the killer's signal sender delivers signal 0 (an existence probe) instead of SIGTERM/SIGKILL
  'skip-kill': {
    desc: 'the kill ladder signals with 0 (no process is ever killed)',
    exercise: 'dure', redden: ['tools_dead'],
    edits: [rx(/(readTable:[\s\S]{1,300}?\},)signal:\((\w+),(\w+)\)=>\{try\{return process\.kill\(\2,\3\),!0\}catch\{return!1\}\}/, (m) => `${m[1]}signal:(${m[2]},${m[3]})=>{try{return process.kill(${m[2]},${'0'.padEnd(m[3].length)}),!0}catch{return!1}}`)],   // the pause-kill deps (the resource reaper has its own \`signal\`, no readTable)
  },
  // chrono instrument: the host notices the pause 90 s late (watch debounce 250 ms → 90 s, sweep interval 15 s → 10 days)
  'slow-detect': {
    desc: 'pause detection delayed 90 s (debounce 250 ms → 9e4, sweep 15 s → 9e8)',
    exercise: 'dure', redden: ['bar:hard_all_paused_lt_60s'],
    edits: [rx(/const (\w+)=15e3,(\w+)=250;/, (m) => `const ${m[1]}=9e8 ,${m[2]}=9e4;`)],
  },
  // self-restart instrument: the pause GATE never reports a paused carrier → a mailed member is woken during the pause
  'gate-ignores-pause': {
    desc: 'pausedCarrierForWorkspace never finds a paused carrier (every gate site opens)',
    exercise: 'dure', redden: ['bar:no_self_restart'],
    edits: [rx(/if\((\w+)&&\1\.pausedAt!==null&&\1\.switchOn\)\{if\(!\((\w+)!=null&&\2\.includeReleased\)/, (m) => `if(${m[1]}&&${m[1]}.pausedAt===-1  &&${m[1]}.switchOn){if(!(${m[2]}!=null&&${m[2]}.includeReleased)`)],
  },
  // accusé instrument: `run confirm reprise` reports success but stamps released_at instead of reprise_confirmed_at (main bundle + CLI bundle)
  'no-confirm-reprise': {
    desc: 'confirm reprise writes the wrong column (accusé lost)',
    exercise: 'dure', redden: ['bar:every_member_reprise_accused'],
    edits: [lit('UPDATE pause_members SET reprise_confirmed_at = ? WHERE run_id = ? AND paused_at = ? AND ws_id = ?', `UPDATE pause_members SET released_at${' '.repeat(10)}= ? WHERE run_id = ? AND paused_at = ? AND ws_id = ?`, 2)],
  },
  // douce deadline instrument: the 3-min deadline never escalates a straggler
  'no-deadline-escalation': {
    desc: 'the Pause douce deadline never escalates (only "all confirmed" does)',
    exercise: 'douce', redden: ['straggler_not_cut_short', 'bar:soft_escalated_by_deadline'],
    edits: [rx(/return (\w+)\|\|(\w+)>=(\w+)\?\((\w+)\((\w+),(\w+)\.runId,\6\.pausedAt,\2\)&&\((\w+)\.escalated=\1\?"all-confirmed":"deadline"/, (m) => `return ${m[1]}||${'0'.padEnd(m[2].length)}>=${m[3]}?(${m[4]}(${m[5]},${m[6]}.runId,${m[6]}.pausedAt,${m[2]})&&(${m[7]}.escalated=${m[1]}?"all-confirmed":"deadline"`)],
  },
  // auto-Pause instrument: the host's usage-limit pause UPDATE can never match
  'no-auto-pause': {
    desc: 'the auto Pause UPDATE has an unsatisfiable guard (a limit stop pauses nothing)',
    exercise: 'auto', redden: ['auto_pause_dure_on_limit'],
    edits: [rx(/(pause_auto = \?\n\s+WHERE id = \? AND paused_at )IS NULL/, (m) => `${m[1]}= -1   `)],
  },
};

/** Apply `edits` to one bundle text (latin1: 1 byte = 1 char, so offsets are byte offsets). Returns { out, hits }; throws when an edit is not same-length. */
export function applyEdits(text, edits) {
  const hits = edits.map(() => 0);
  let out = text;
  edits.forEach((e, i) => {
    out = out.replace(e.re, (...a) => {
      const idx = a.findIndex((x) => typeof x === 'number');
      const m = a.slice(0, idx);
      const to = e.to(m);
      if (to.length !== m[0].length) throw new Error(`mutant edit not same-length at ${e.label}: ${m[0].length} vs ${to.length}`);
      hits[i]++;
      return to;
    });
  });
  return { out, hits };
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The byte ranges of the bundles the app really LOADS inside app.asar: dist-electron/{main.js, cli.js, keeper.js, preload.js} + every chunk they require.
 *  asar = [u32 4][u32 headerPickleSize][pickle: u32 len, u32 strLen, JSON]…file data at 8 + headerPickleSize. */
export function liveBundles(buf) {
  const headerSize = buf.readUInt32LE(4);
  const strLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.slice(16, 16 + strLen).toString('utf8'));
  const dir = header.files?.['dist-electron']?.files;
  if (!dir) throw new Error('app.asar has no dist-electron');
  const base = 8 + headerSize;
  const range = (name) => { const f = dir[name]; if (!f || f.unpacked) return null; return { name, start: base + Number(f.offset), end: base + Number(f.offset) + f.size }; };
  const live = new Map();
  const visit = (name) => {
    if (live.has(name)) return;
    const r = range(name);
    if (!r) return;
    live.set(name, r);
    for (const m of buf.toString('latin1', r.start, r.end).matchAll(/require\("\.\/([^"]+\.js)"\)/g)) visit(m[1]);
  };
  for (const n of ['main.js', 'cli.js', 'keeper.js', 'preload.js']) visit(n);
  return [...live.values()];
}

/** Copy the unpacked app (reflink: instant on btrfs) and patch its app.asar. Returns { dir, bin, edits:[{label, hits, expect, where}], baseSha, copySha }. Throws PATTERN-GONE on a count mismatch. */
export function makeMutantApp(baseDir, name, outDir) {
  const m = MUTANTS[name];
  if (!m) throw new Error(`unknown mutant ${name} (have: ${Object.keys(MUTANTS).join(', ')})`);
  const baseAsar = path.join(baseDir, 'resources', 'app.asar');
  const baseBefore = sha(fs.readFileSync(baseAsar));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  execFileSync('cp', ['-a', '--reflink=auto', baseDir, outDir]);
  const asar = path.join(outDir, 'resources', 'app.asar');
  fs.rmSync(asar);   // break the reflink/link to the base file: the write below must never reach it
  const buf = fs.readFileSync(baseAsar);
  const report = m.edits.map((e) => ({ label: e.label, hits: 0, expect: e.expect, where: [] }));
  for (const rg of liveBundles(buf)) {
    const text = buf.toString('latin1', rg.start, rg.end);
    const { out, hits } = applyEdits(text, m.edits);
    hits.forEach((h, i) => { if (h > 0) { report[i].hits += h; report[i].where.push(`${rg.name}×${h}`); } });
    if (out !== text) Buffer.from(out, 'latin1').copy(buf, rg.start);
  }
  for (const r of report) if (r.hits !== r.expect) throw new Error(`PATTERN-GONE: mutant ${name}: anchor ${JSON.stringify(r.label)} matched ${r.hits}× in the LIVE bundles of ${baseAsar} (${r.where.join(',') || 'none'}), expected ${r.expect} — the bundle moved on, re-derive the anchor`);
  fs.writeFileSync(asar, buf);
  const baseAfter = sha(fs.readFileSync(baseAsar));
  if (baseAfter !== baseBefore) throw new Error(`BASE APP MODIFIED: ${baseAsar} changed under mutant ${name}`);
  return { dir: outDir, bin: path.join(outDir, 'orchestra'), edits: report, baseSha: baseBefore.slice(0, 12), copySha: sha(buf).slice(0, 12) };
}
