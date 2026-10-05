// Pause canary (#258) — BUILD-LEVEL mutants of the PACKAGED app, to prove each drill instrument can say FAIL (ledger #281 G3 F2).
// The shipped bundles inside `resources/app.asar` are patched IN A COPY of the unpacked app (never the original): every edit is a SAME-LENGTH byte replacement of a unique
// minified-bundle anchor, so the asar's offsets/header stay valid with no repack. `expect` = the exact number of occurrences (one per bundle that carries the code):
// a count mismatch is PATTERN-GONE (the bundle moved on) = the arm is VOID, never a silent green.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const same = (find, replace) => { if (Buffer.byteLength(find) !== Buffer.byteLength(replace)) throw new Error(`mutant edit not same-length (${Buffer.byteLength(find)} vs ${Buffer.byteLength(replace)}): ${find.slice(0, 60)}`); return { find, replace }; };

/** name → { desc, exercise (the drill that must go red), redden (the check ids that must go RED), edits: [{find, replace, expect}] } */
export const MUTANTS = {
  // lost-work instrument: the pause snapshot's `git add -A` becomes a dry run → the ref is taken but holds no untracked / tracked-edit work
  'skip-snapshot': {
    desc: 'snapshot `git add -A` → `git add -n` (dry run): the pause ref misses the uncommitted + untracked work',
    exercise: 'dure', redden: ['bar:lost_work_is_zero'],
    edits: [
      { ...same('["add","-A","--ignore-errors","--",...h]', '["add","-n","--ignore-errors","--",...h]'), expect: 1 },
      { ...same('["add","-A","--ignore-errors",`--pathspec-from-file=${m}`', '["add","-n","--ignore-errors",`--pathspec-from-file=${m}`'), expect: 1 },
    ],
  },
  // hold instrument (Pause dure not held): the killer's signal sender delivers signal 0 (an existence probe) instead of SIGTERM/SIGKILL
  'skip-kill': {
    desc: 'the kill ladder signals with 0 (no process is ever killed)',
    exercise: 'dure', redden: ['tools_dead'],
    edits: [{ ...same('signal:(t,n)=>{try{return process.kill(t,n),!0}catch{return!1}}', 'signal:(t,n)=>{try{return process.kill(t,0),!0}catch{return!1}}'), expect: 1 }],
  },
  // chrono instrument: the host notices the pause 90 s late (watch debounce 250 ms → 90 s, sweep interval 15 s → 10 days)
  'slow-detect': {
    desc: 'pause detection delayed 90 s (debounce 250 ms → 9e4, sweep 15 s → 9e8)',
    exercise: 'dure', redden: ['bar:hard_all_paused_lt_60s'],
    edits: [{ ...same('const bc=15e3,nx=250;', 'const bc=9e8 ,nx=9e4;'), expect: 1 }],
  },
  // self-restart instrument: the pause GATE never reports a paused carrier → a mailed member is woken during the pause
  'gate-ignores-pause': {
    desc: 'pausedCarrierForWorkspace never finds a paused carrier (every gate site opens)',
    exercise: 'dure', redden: ['bar:no_self_restart'],
    edits: [{ ...same('if(u&&u.pausedAt!==null&&u.switchOn){if(!(r!=null&&r.includeReleased)', 'if(u&&u.pausedAt===-1  &&u.switchOn){if(!(r!=null&&r.includeReleased)'), expect: 1 }],
  },
  // accusé instrument: `run confirm reprise` reports success but stamps released_at instead of reprise_confirmed_at (main bundle + CLI bundle)
  'no-confirm-reprise': {
    desc: 'confirm reprise writes the wrong column (accusé lost)',
    exercise: 'dure', redden: ['bar:every_member_reprise_accused'],
    edits: [{ ...same('UPDATE pause_members SET reprise_confirmed_at = ? WHERE run_id = ? AND paused_at = ? AND ws_id = ?', 'UPDATE pause_members SET released_at          = ? WHERE run_id = ? AND paused_at = ? AND ws_id = ?'), expect: 2 }],
  },
  // douce deadline instrument: the 3-min deadline never escalates a straggler
  'no-deadline-escalation': {
    desc: 'the Pause douce deadline never escalates (only "all confirmed" does)',
    exercise: 'douce', redden: ['bar:soft_escalated_by_deadline'],
    edits: [{ ...same('l||r>=s?(Dy(t,n.runId', 'l||0>=s?(Dy(t,n.runId'), expect: 1 }],
  },
  // auto-Pause instrument: the host's usage-limit pause UPDATE can never match
  'no-auto-pause': {
    desc: 'the auto Pause UPDATE has an unsatisfiable guard (a limit stop pauses nothing)',
    exercise: 'auto', redden: ['auto_pause_dure_on_limit'],
    edits: [{ ...same('WHERE id = ? AND paused_at IS NULL`).run(d,mm,Xo(f,d),u)', 'WHERE id = ? AND paused_at = -1   `).run(d,mm,Xo(f,d),u)'), expect: 1 }],
  },
};

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Copy the unpacked app (reflink: instant on btrfs) and patch its app.asar. Returns { dir, bin, edits:[{find, hits}], baseSha, copySha }. Throws PATTERN-GONE on a count mismatch. */
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
  let buf = fs.readFileSync(baseAsar);
  const report = [];
  for (const e of m.edits) {
    const f = Buffer.from(e.find), r = Buffer.from(e.replace);
    let hits = 0, at = 0;
    for (;;) { const i = buf.indexOf(f, at); if (i < 0) break; r.copy(buf, i); hits++; at = i + f.length; }
    report.push({ find: e.find.slice(0, 70), hits, expect: e.expect });
    if (hits !== e.expect) throw new Error(`PATTERN-GONE: mutant ${name}: anchor ${JSON.stringify(e.find.slice(0, 70))} matched ${hits}× in ${baseAsar}, expected ${e.expect} — the bundle moved on, re-derive the anchor`);
  }
  fs.writeFileSync(asar, buf);
  const baseAfter = sha(fs.readFileSync(baseAsar));
  if (baseAfter !== baseBefore) throw new Error(`BASE APP MODIFIED: ${baseAsar} changed under mutant ${name}`);
  return { dir: outDir, bin: path.join(outDir, 'orchestra'), edits: report, baseSha: baseBefore.slice(0, 12), copySha: sha(buf).slice(0, 12) };
}
