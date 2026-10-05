#!/usr/bin/env node
// Pause canary (#258): in-place-style mutants of bars.mjs against src/main/pause-canary-bars.test.ts — the unit layer's own proof (each instrument's bar can say FAIL).
// Runs in a SCRATCH COPY (never the working tree), clean control before AND after, anchors must match exactly once, the copy of bars.mjs is restored byte-exact (cmp).
//   node scripts/pause-canary/mutate-bars.mjs        exit 0 = every mutant killed, 1 = a mutant survived / the control is not clean
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = path.join(os.homedir(), '.cache', 'pause-canary');
const tmp = fs.mkdtempSync(path.join(base, 'mutbars-'));
fs.mkdirSync(path.join(tmp, 'src', 'main'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'scripts', 'pause-canary'), { recursive: true });
for (const f of fs.readdirSync(path.join(REPO, 'scripts', 'pause-canary'))) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(REPO, 'scripts', 'pause-canary', f), path.join(tmp, 'scripts', 'pause-canary', f));
fs.copyFileSync(path.join(REPO, 'src', 'main', 'pause-canary-bars.test.ts'), path.join(tmp, 'src', 'main', 'pause-canary-bars.test.ts'));
const targetOf = (f) => path.join(tmp, 'scripts', 'pause-canary', f);
const origOf = Object.fromEntries(['bars.mjs', 'lib.mjs'].map((f) => [f, fs.readFileSync(targetOf(f), 'utf8')]));
const run = () => { const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', 'src/main/pause-canary-bars.test.ts'], { cwd: tmp, encoding: 'utf8' }); return { pass: Number(/# pass (\d+)/.exec(r.stdout)?.[1] ?? -1), fail: Number(/# fail (\d+)/.exec(r.stdout)?.[1] ?? -1) }; };

const MUTANTS = [
  ['hard-bar-le', 'm.tAllPausedS < BARS.hardAllPausedS', 'm.tAllPausedS <= BARS.hardAllPausedS'],
  ['hard-bar-null-ok', 'num(m.tAllPausedS) && m.tAllPausedS < BARS.hardAllPausedS', '(!num(m.tAllPausedS) || m.tAllPausedS < BARS.hardAllPausedS)'],
  ['lost-ge1', 'lw.lostCount === BARS.lostWork', 'lw.lostCount <= 1'],
  ['lost-vacuous', 'lw.markers > 0 && lw.lostCount', 'lw.lostCount'],
  ['branches-zero', '&& lw.branches > 0,', ','],
  ['selfrestart-probes', '&& sr.probes > 0', ''],
  ['accuse-n', 'ra.n === ra.m &&', ''],
  ['soft-deadline-const-gone', "add('bar:soft_deadline_is_3_min', num(m.deadlineS) && Math.abs(m.deadlineS - BARS.softDeadlineS) <= 1", "add('bar:soft_deadline_is_3_min', true"],
  ['soft-deadline-tolerance', 'Math.abs(m.deadlineS - BARS.softDeadlineS) <= 1', 'Math.abs(m.deadlineS - BARS.softDeadlineS) <= 30'],
  ['soft-slack', 'esc <= BARS.softDeadlineS + BARS.softEscalationSlackS', 'esc <= BARS.softDeadlineS + 50'],
  ['soft-from-app', 'esc <= BARS.softDeadlineS + BARS.softEscalationSlackS', 'esc <= m.deadlineS + BARS.softEscalationSlackS'],
  ['soft-trap', 'm.tAllPausedS < esc + BARS.softTrapAfterEscalationS', 'm.tAllPausedS < esc + 600'],
  ['pause-roster-min', 'pa.n === pa.m && pa.m >= (m.rosterMin ?? 1)', 'pa.n === pa.m'],
  ['resumed-optional', "add('published:time_to_all_resumed', num(m.tAllResumedS)", "add('published:time_to_all_resumed', true"],
  ['found-any', "typeof mk.found?.[loc] === 'string' && mk.found[loc].includes(mk.needle)", "typeof mk.found?.[loc] === 'string'"],
  ['window-open', 'r.t >= w.from && (w.until === null', 'r.t >= w.from - 1e12 && (w.until === null'],
  ['until-inclusive', 'r.t < w.until)', 'r.t <= w.until)'],
  ['tools-ignored', 'if (!(r.tools > 0)) continue;', ''],
  ['limitprompt-dropped', "limitPrompt: r.limitPrompt === true,", ''],
  ['tool-app-exclusion-removed', "if (k === 'app') return false;", "if (k === 'app') return true;"],
  ['tool-cli-stop-removed', "if (k === 'claude' || k === 'keeper') return true;", "if (false) return true;"],
  ['tool-orphan-not-counted', "if (!parent) return true;", "if (!parent) return false;"],
  ['tool-member-check-removed', "if (!memberOf(p)) return false;", ""],
  ['window-own-via-removed', "const own = (row?.pause_confirm_via === 'trap' || row?.pause_confirm_via === 'host-idle') && num(done);", "const own = num(done);"],
  ['window-own-never', "if (own && done < tTrapDone)", "if (false)"],
  ['window-run-stamp-dropped', "out.push({ role: '*', from: tTrapDone, until: tR, label: 'hold' });", ""],
  ['window-legacy-ignored', "if (!legacy) {", "if (true) {"],
  ['tool-cli-client-counted', "if (/orchestra cli /.test(p.cmd) || / cli /.test(p.cmd)) return false;", ""],
  ['window-stamp-guard-removed', "&& num(done);", ";"],
  ['gap-missing-row-ignored', "if (!row) { if (!m.optional) gaps.push(`${m.role}: no roster row`); continue; }", "if (!row) continue;"],
  ['gap-optional-ignored', "if (!m.optional) gaps.push", "if (true) gaps.push"],
  ['gap-member-route-flagged', "if (via === 'member') continue;", ""],
  ['gap-route-ignored', "if (via !== 'trap' && via !== 'host-idle') {", "if (false) {"],
  ['gap-unstamped-ignored', "if (!num(row.pause_confirmed_at)) gaps.push(", "if (false) gaps.push("],
  ['verdict-premise-ignored', "!reached || premiseRed.length ? 'RIG-BROKE'", "!reached ? 'RIG-BROKE'"],
  ['verdict-reached-ignored', "!reached || premiseRed.length ? 'RIG-BROKE'", "premiseRed.length ? 'RIG-BROKE'"],
  ['kind-app-anywhere', "/^(\\S*\\/)?orchestra( |$)/.test(p.cmd)", "/orchestra( |$)/.test(p.cmd)", 'lib.mjs'],
  ['snapshot-transient-listed', ".filter((n) => !isTransientName(n))", "", 'lib.mjs'],
];
const clean = run();
let bad = 0;
console.log(`CLEAN control: pass ${clean.pass} fail ${clean.fail}`);
if (clean.fail !== 0 || clean.pass < 1) { console.log('CLEAN control is not clean — nothing measured'); process.exit(1); }
for (const [name, find, replace, file = 'bars.mjs'] of MUTANTS) {
  const orig = origOf[file];
  const hits = orig.split(find).length - 1;
  if (hits !== 1) { console.log(`${name}: PATTERN-GONE (anchor matched ${hits}×)`); bad++; continue; }
  fs.writeFileSync(targetOf(file), orig.replace(find, () => replace));
  const r = run();
  fs.writeFileSync(targetOf(file), orig);
  const killed = r.fail > 0;
  if (!killed) bad++;
  console.log(`${name}: ${killed ? 'killed' : 'SURVIVED'} (pass ${r.pass} fail ${r.fail})`);
}
const same = Object.keys(origOf).every((f) => fs.readFileSync(targetOf(f), 'utf8') === origOf[f]);
const after = run();
console.log(`restored byte-exact: ${same}; CLEAN control after: pass ${after.pass} fail ${after.fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`MUTATE-BARS: ${bad === 0 && same && after.fail === 0 ? 'PASS' : 'FAIL'} (${MUTANTS.length} mutants)`);
process.exit(bad === 0 && same && after.fail === 0 ? 0 : 1);
