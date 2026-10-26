// Verifier (seat 1, #389 FINAL 39243f07): live attacks on the REAL src/main/linux-keyring.ts probeSecretService with stub "gdbus" programs.
// No D-Bus at all: the stubs never connect to anything; every scratch file lives under $TMPDIR. usage: node --experimental-strip-types probe-final.mjs <repo>
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = path.resolve(process.argv[2]);
const K = await import(pathToFileURL(path.join(repo, 'src/main/linux-keyring.ts')).href);
const base = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'probefinal-'));
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0, ok = 0;
const row = (id, pass, label, detail = '') => { if (pass) ok++; else bad++; console.log(`${id.padEnd(4)} ${pass ? 'OK ' : 'BAD'} ${label}${detail ? ` | ${detail}` : ''}`); };
const stub = (name, body) => { const f = path.join(base, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
const counter = (name) => path.join(base, `${name}.count`);
const calls = (name) => { try { return fs.readFileSync(counter(name), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const run = (program, opts = {}) => { const notes = []; const t = Date.now(); const state = K.probeSecretService({ program, waitMs: opts.waitMs ?? 3000, env: opts.env ?? { PATH: '/usr/bin:/bin', HOME: base, LANG: 'C.UTF-8' }, scratchDirs: [base], note: (m) => notes.push(m), spawn: opts.spawn }); return { state, notes, ms: Date.now() - t }; };
const SLEEP = '/usr/bin/sleep';

// ── controls (a probe harness that cannot say yes is worthless) ──
{ const p = stub('ok-unlocked', `echo x >> ${counter('ok-unlocked')}; echo '(<false>,)'`); const r = run(p); row('C1', r.state === 'unlocked' && calls('ok-unlocked') === 1 && r.notes.length === 0, 'CONTROL: (<false>,) → unlocked, one call, no note', `${r.state} ${r.ms} ms notes=${JSON.stringify(r.notes)}`); }
{ const p = stub('ok-locked', `echo x >> ${counter('ok-locked')}; echo '(<true>,)'`); const r = run(p); row('C2', r.state === 'locked' && calls('ok-locked') === 1, 'CONTROL: (<true>,) → locked', `${r.state} ${r.ms} ms`); }
// ── retry semantics ──
{ const p = stub('quick-fail', `echo x >> ${counter('quick-fail')}; exit 1`); const r = run(p); row('R1', r.state === 'unavailable' && calls('quick-fail') === 2 && r.notes.length === 2 && /retrying once/.test(r.notes[0]) && r.ms >= 100, 'immediate exit 1, no stderr → retried ONCE (2 calls), both attempts noted', `calls=${calls('quick-fail')} ${r.ms} ms notes=${JSON.stringify(r.notes)}`); }
{ const p = stub('reply-fail', `echo x >> ${counter('reply-fail')}; echo 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files' >&2; exit 1`); const r = run(p); row('R2', r.state === 'unavailable' && calls('reply-fail') === 1 && r.notes.length === 0, 'a GDBus.Error reply (real "no service") is NEVER retried and is silent', `calls=${calls('reply-fail')} ${r.ms} ms notes=${JSON.stringify(r.notes)}`); }
{ const p = stub('noreply', `echo x >> ${counter('noreply')}; echo 'Error: GDBus.Error:org.freedesktop.DBus.Error.NoReply: Message recipient disconnected from message bus without replying' >&2; exit 1`); const r = run(p); row('R3', calls('noreply') === 1, 'NoReply (daemon died mid-call) counts as a reply: one call (declared design)', `calls=${calls('noreply')} ${r.state}`); }
{ const p = stub('flaky', `n=$(cat ${counter('flaky')} 2>/dev/null | wc -l); echo x >> ${counter('flaky')}; if [ "$n" = 0 ]; then echo 'Error connecting: Could not connect: No such file or directory' >&2; exit 1; fi; echo '(<false>,)'`); const r = run(p); row('R4', r.state === 'unlocked' && calls('flaky') === 2, 'transient quick failure then a real answer → the answer wins (unlocked), 2 calls', `${r.state} calls=${calls('flaky')} ${r.ms} ms notes=${JSON.stringify(r.notes)}`); }
{ const p = stub('slow-fail', `echo x >> ${counter('slow-fail')}; ${SLEEP} 0.3; exit 1`); const r = run(p); row('R5', r.state === 'unavailable' && calls('slow-fail') === 2 && r.ms >= 700, 'CONTRACT 6456bd28: a failure after 300 ms (no wall-clock "quick" test any more) IS retried once → 2 calls', `calls=${calls('slow-fail')} ${r.ms} ms notes=${JSON.stringify(r.notes)}`); }
{ const p = stub('quick-then-slow', `n=$(cat ${counter('quick-then-slow')} 2>/dev/null | wc -l); echo x >> ${counter('quick-then-slow')}; if [ "$n" = 0 ]; then exit 1; fi; ${SLEEP} 0.4; echo '(<true>,)'`); const r = run(p); row('R6', r.state === 'locked' && calls('quick-then-slow') === 2, 'retry result is honoured even when the 2nd attempt is slow', `${r.state} ${r.ms} ms`); }
{ const p = stub('qf400', `echo x >> ${counter('qf400')}; exit 1`); const r = run(p, { waitMs: 400 }); row('R7', calls('qf400') === 1 && r.notes.every((n) => !/retrying/.test(n)), 'waitMs 400: no retry fits (400-100 < 500) and the note does NOT claim "retrying once"', `calls=${calls('qf400')} ${r.ms} ms notes=${JSON.stringify(r.notes)}`); }
{ const p = stub('qf590', `echo x >> ${counter('qf590')}; exit 1`); const r = run(p, { waitMs: 590 }); row('R7b', calls('qf590') === 1, 'waitMs 590: budget counts the 100 ms RETRY DELAY (575-100=475 < 500) → no retry', `calls=${calls('qf590')} ${r.ms} ms`); }
{ const p = stub('qf800', `echo x >> ${counter('qf800')}; exit 1`); const r = run(p, { waitMs: 800 }); row('R7c', calls('qf800') === 2, 'waitMs 800: (785-100=685 >= 500) → retried', `calls=${calls('qf800')} ${r.ms} ms`); }
{ const p = stub('late-fail', `echo x >> ${counter('late-fail')}; ${SLEEP} 0.95; exit 1`); const r = run(p, { waitMs: 1500 }); row('R10', calls('late-fail') === 1, 'waitMs 1500, failure at ~950 ms: 550-100 < 500 → NOT retried', `calls=${calls('late-fail')} ${r.ms} ms`); }
{ const p = stub('early-fail', `echo x >> ${counter('early-fail')}; ${SLEEP} 0.3; exit 1`); const r = run(p, { waitMs: 1500 }); row('R10b', calls('early-fail') === 2, 'waitMs 1500, failure at ~300 ms: retried', `calls=${calls('early-fail')} ${r.ms} ms`); }
{ const p = stub('exit3', `echo x >> ${counter('exit3')}; exit 3`); const r = run(p); row('R11', calls('exit3') === 1 && /wait deadline/.test(r.notes[0] ?? ''), 'a CHILD that itself exits 3 is read as the wait-deadline marker (declared ambiguity: gdbus never exits 3)', `calls=${calls('exit3')} notes=${JSON.stringify(r.notes)}`); }
// R8: a spawn error (EAGAIN) on the first attempt, the real spawn afterwards → retried, the real answer wins
{ const EAGAIN = Object.assign(new Error('spawnSync sh EAGAIN'), { code: 'EAGAIN' }); const p = stub('after-eagain', `echo x >> ${counter('after-eagain')}; echo '(<false>,)'`); let n = 0; const spawn = (...a) => (++n === 1 ? { error: EAGAIN, status: null } : spawnSync(...a)); const r = run(p, { spawn }); row('R8', r.state === 'unlocked' && n === 2 && calls('after-eagain') === 1 && r.notes.some((m) => /spawn EAGAIN/.test(m)), 'spawn EAGAIN on attempt 1 → retried once, the real answer wins, the failure is noted', `${r.state} spawns=${n} notes=${JSON.stringify(r.notes)}`); }
// R9: an immediate failure then a HANG: the whole thing still ends at ONE overall wait (the retry gets the REMAINING time, not a fresh one)
{ const p = stub('quick-then-hang', `n=$(cat ${counter('quick-then-hang')} 2>/dev/null | wc -l); echo x >> ${counter('quick-then-hang')}; if [ "$n" = 0 ]; then exit 1; fi; ${SLEEP} 20`); const ts = []; for (let i = 0; i < 3; i++) { fs.rmSync(counter('quick-then-hang'), { force: true }); const r = run(p, { waitMs: 1000 }); ts.push(r.ms); } row('R9', Math.max(...ts) <= 1080 && Math.min(...ts) >= 990, 'quick fail then hang, waitMs 1000: total ends at ONE overall wait (<= 1080 ms, 3 runs), never wait + retry', `ms=${JSON.stringify(ts)}`); }
// ── wall-clock deadline + no signal ──
{ const pid = path.join(base, 'hang.pid'); const sig = path.join(base, 'hang.sig'); const p = stub('hang', `echo $$ > ${pid}; trap 'echo TERM >> ${sig}' TERM; trap 'echo INT >> ${sig}' INT; trap 'echo HUP >> ${sig}' HUP; echo x >> ${counter('hang')}; i=0; while [ $i -lt 600 ]; do ${SLEEP} 0.1; i=$((i+1)); done`); const r = run(p, { waitMs: 800 }); await sleepMs(1500);
  const hp = Number(fs.readFileSync(pid, 'utf8')); let alive = false; try { process.kill(hp, 0); alive = true; } catch {}
  row('D1', r.state === 'unavailable' && r.ms >= 780 && r.ms <= 1500 && calls('hang') === 1, 'hung child: returns unavailable at the wall-clock deadline (800 ms), no retry', `${r.ms} ms calls=${calls('hang')} notes=${JSON.stringify(r.notes)}`);
  row('D2', alive && !fs.existsSync(sig), 'NO SIGNAL is ever sent: the hung child is still alive 1.5 s after the deadline and its TERM/INT/HUP traps never fired', `alive=${alive} sigfile=${fs.existsSync(sig)}`);
  try { process.kill(hp, 'SIGKILL'); } catch {} }
{ const done = path.join(base, 'orphan.done'); const p = stub('orphan', `${SLEEP} 2.5; echo done > ${done}; echo '(<false>,)'`); const r = run(p, { waitMs: 500 }); await sleepMs(3500);
  row('D3', r.state === 'unavailable' && fs.existsSync(done), 'the orphaned child FINISHES ITS OWN call after we stopped waiting (marker written 3.5 s later; the scratch dir was already removed)', `${r.state} ${r.ms} ms marker=${fs.existsSync(done)}`); }
// ── a `sleep` that cannot fork (PATH without sleep): the old iteration-counted loop would end the wait EARLY ──
{ const nopath = path.join(base, 'nosleep-bin'); fs.mkdirSync(nopath); fs.symlinkSync('/bin/sh', path.join(nopath, 'sh')); for (const t of ['cat', 'wc']) fs.symlinkSync(`/usr/bin/${t}`, path.join(nopath, t));
  const p = stub('hang2', `i=0; while [ $i -lt 100 ]; do ${SLEEP} 0.1; i=$((i+1)); done`);
  const t = Date.now(); const r = run(p, { waitMs: 1500, env: { PATH: nopath, HOME: base, LANG: 'C.UTF-8' } }); const ms = Date.now() - t;
  row('D4', r.state === 'unavailable' && ms >= 1450 && ms <= 2600, 'PATH without `sleep` (every tick fails): the wait still lasts the WALL-CLOCK 1500 ms — not cut short', `${ms} ms notes=${JSON.stringify(r.notes)}`); }

// Z: log-injection through the startup facts (m2): peer-controlled stderr / stdout never reaches the log with control characters or an unquoted field
{
  const bin = path.join(base, 'zbin'); fs.mkdirSync(bin);
  const gd = (body) => fs.writeFileSync(path.join(bin, 'gdbus'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const facts = () => K.selectLinuxPasswordStore({ platform: 'linux', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base, XDG_CURRENT_DESKTOP: 'sway', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-orch-bus' }, argv: [], hasSwitch: () => false, appendSwitch() {}, exportBusAddress() {}, extraScratchDirs: [base] });
  gd(`printf 'x\\033[31mRED "q" \\\\ back\\r\\nINJECT=1 fake-field="y"\\342\\200\\250more' >&2; exit 1`);
  const r1 = facts(); const line = r1?.facts ?? '';
  row('Z1', r1 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line) && /probe-notes="/.test(line) && !/probe-notes=[^"]/.test(line), 'hostile stderr (ESC, CR, LF, quote, backslash, U+2028) → the facts line has NO control/line-separator characters and a JSON-quoted notes value', JSON.stringify(line).slice(0, 260));
  const tail = line.slice(line.indexOf('probe-notes=') + 'probe-notes='.length); const m = [tail]; let parsed = null; try { parsed = JSON.parse(tail); } catch {} /* the ENTIRE remainder of the facts line must be ONE JSON string */
  row('Z2', typeof parsed === 'string', 'the quoted notes value round-trips and nothing of the peer text escapes the quotes', JSON.stringify(parsed)?.slice(0, 200));
  gd(`printf '\\033]0;owned\\007\\302\\205evil \\342\\200\\256rtl' ; exit 0`);
  const r2 = facts(); const l2 = r2?.facts ?? '';
  row('Z3', r2 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(l2), 'hostile STDOUT of a status-0 junk reply (OSC title, NEL, RLO) is cleaned in the facts too', JSON.stringify(l2).slice(0, 220));
  gd(`echo '(<false>,)'`); const r3 = facts(); row('Z4', r3 && !/probe-notes/.test(r3.facts) && r3.store === 'gnome-libsecret', 'CONTROL: a clean reply → no probe-notes, libsecret chosen', JSON.stringify(r3?.facts));
}
// ── junk / huge output ──
{ const p = stub('junk', `echo x >> ${counter('junk')}; head -c 200000 /dev/zero | tr '\\0' 'A'; echo`); const r = run(p); row('J1', r.state === 'unavailable' && calls('junk') === 1 && r.notes.every((n) => n.length < 200), 'status 0 + 200 kB of junk → unavailable, ONE call, note capped', `${r.state} notes=${JSON.stringify(r.notes).slice(0, 200)}`); }
{ const p = stub('bigerr', `echo x >> ${counter('bigerr')}; head -c 500000 /dev/zero | tr '\\0' 'E' >&2; echo >&2; exit 1`); const r = run(p); row('J2', r.state === 'unavailable' && r.notes.every((n) => n.length < 300), '500 kB stderr line: first-line cap keeps the note short', `calls=${calls('bigerr')} note-len=${r.notes.map((n) => n.length)}`); }
{ const p = stub('multiline-err', `echo x >> ${counter('multiline-err')}; printf '\\n\\nwarning: something\\nError: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: x\\n' >&2; exit 1`); const r = run(p); row('J3', calls('multiline-err') === 2, 'a GDBus.Error on a LATER stderr line (first non-empty line is a warning) is not seen as a reply → retried (declared: only the first line is read)', `calls=${calls('multiline-err')}`); }
{ const p = stub('err-injection', `echo x >> ${counter('err-injection')}; echo 'Error connecting: path /run/GDBus.Error: weird' >&2; exit 1`); const r = run(p); row('J4', calls('err-injection') === 1, 'a connect failure whose text merely CONTAINS "GDBus.Error:" is treated as a reply (no retry) — benign misclassification, noted', `calls=${calls('err-injection')}`); }
// ── wall cost of the worst case ──
{ const p = stub('quick-fail-2', `exit 1`); const t = Date.now(); const r = run(p, { waitMs: 5000 }); row('W1', r.ms < 600, 'two immediate failures cost well under a second at the production wait (5000 ms)', `${r.ms} ms`); }
// ── ten unmutated repeats of the retry arms (timing-sensitive) ──
{ let fails = 0; for (let i = 0; i < 10; i++) { fs.rmSync(counter('rep'), { force: true }); const p = stub('rep', `echo x >> ${counter('rep')}; exit 1`); const r = run(p); if (!(calls('rep') === 2 && r.state === 'unavailable')) fails++; } row('X1', fails === 0, '10 repeats of the immediate-failure arm: always 2 calls', `fails=${fails}`); }
console.log(`SUMMARY ok=${ok} bad=${bad}`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
