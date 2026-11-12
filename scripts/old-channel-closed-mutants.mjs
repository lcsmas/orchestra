#!/usr/bin/env node
// #441 self-gate — IN-PLACE mutation sweep of "the old channel is closed" (the `orchestra message` refusal, the `--emergency` escape, the one-command footer, the `delivery` switch removal, the row-less 'default' reads, the skill text).
// Each mutant removes ONE guard in the real source and must turn its NAMED unit file(s) and/or the built-CLI rig (scripts/e2e-old-channel-closed.mjs) red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED
// tree. CONTROL first: every named unit file AND the rig must be GREEN unmutated (skipped 0). CLI mutants rebuild dist-electron/cli.js (the rig execs the bundle); rebuilt again after.
// Run: node scripts/old-channel-closed-mutants.mjs [--only MC01,MC07] [--check-anchors]   (pnpm run test:old-channel-closed-mutants)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const GATE = 'src/shared/message-channel-gate.ts', WS = 'src/main/workspaces.ts', CLIX = 'src/cli/index.ts', PEER = 'src/shared/peer-messages.ts', SW = 'src/shared/bus-switches.ts';
const ALERT = 'src/main/memory-alert.ts', MIRROR = 'src/main/bus-mirror.ts', WAKE = 'src/main/bus-wake.ts', LIVE = 'src/main/bus-liveness.ts', DOG = 'src/main/session-watchdog.ts';
const T = {
  gate: 'src/main/message-channel-gate.test.ts', peer: 'src/shared/peer-messages.test.ts', sw: 'src/shared/bus-switches.test.ts', runs: 'src/main/bus-runs.test.ts',
  alert: 'src/main/memory-alert.test.ts', mirror: 'src/main/bus-mirror.test.ts', skills: 'src/main/old-channel-closed-skills.test.ts', wiring: 'src/main/old-channel-closed-wiring.test.ts',
};
const RIG = 'rig';

/** One mutant = exact-once edits [file, find, replacement]. `tests` (unit files) and/or `RIG` must go red; `cli` = rebuild the CLI bundle first. */
const MUTANTS = [
  { id: 'MC01', name: 'the gate lets every non-emergency send through (the old channel is open again, any target)', cli: true, edits: [[GATE, 'return { allow: false, error: messageChannelRefusal(input.to, input.text) };', 'return { allow: true };']], tests: [T.gate], rig: true },
  { id: 'MC02', name: '--emergency is refused too (the escape for a wedged reader is gone)', cli: true, edits: [[GATE, 'if (input.emergency) return { allow: true };', '']], tests: [T.gate], rig: true },
  { id: 'MC03', name: 'the refusal no longer prints the equivalent `orchestra send` command', cli: true, edits: [[GATE, '`Use: ${equivalentSendCommand(to, text)}\\n` +', "'Use: orchestra send.\\n' +"]], tests: [T.gate], rig: true },
  { id: 'MC04', name: 'the printed command is not paste-safe (text left unquoted)', edits: [[GATE, "return `'${s.replace(/'/g, `'\\\\''`)}'`;", 'return s;']], tests: [T.gate] },
  { id: 'MC05', name: 'the host wrapper computes the verdict and IGNORES a refusal (delivers anyway)', cli: true, edits: [[WS, "  if (!gate.allow) {\n    return { ok: false, error: gate.error };\n  }\n", '']], tests: [T.gate], rig: true },
  { id: 'MC06', name: 'the host wrapper drops the caller\'s --emergency flag (every poke refused)', cli: true, edits: [[WS, '    emergency: input.emergency === true,\n    to: input.to,', '    emergency: false,\n    to: input.to,']], tests: [T.gate], rig: true },
  { id: 'MC07', name: 'the broadcast hard-codes emergency:true per target (a plain --to dodges the refusal)', cli: true, edits: [[WS, '        text,\n        emergency: input.emergency === true,\n      });', '        text,\n        emergency: true,\n      });']], tests: [T.gate], rig: true },
  { id: 'MC08', name: 'the CLI broadcast form drops the leading --emergency (the group-stop is refused)', cli: true, edits: [[CLIX, "          // bypasses the refusal.\n          ...(emergency ? { emergency: true } : {}),", '          // bypasses the refusal.']], rig: true },
  { id: 'MC09', name: 'the CLI positional form drops --emergency (every poke refused)', cli: true, edits: [[CLIX, "        text,\n        ...(emergency ? { emergency: true } : {}),\n      });\n      if (!res.ok) fail(res.error ?? 'failed to deliver message');", "        text,\n      });\n      if (!res.ok) fail(res.error ?? 'failed to deliver message');"]], rig: true },
  { id: 'MC10', name: 'the CLI takes --emergency from ANYWHERE in argv (a body token upgrades an ordinary send)', cli: true, edits: [[CLIX, "const emergency = args[0] === '--emergency';", "const emergency = args.includes('--emergency');"]], rig: true },
  { id: 'MC11', name: 'the reply footer offers a SECOND channel again (`orchestra message … on a legacy delivery-OFF run`)', cli: true, edits: [[PEER, '`Reply with: orchestra send --type status --to ${fromId} "<reply>"`\n  );', '`Reply with: orchestra send --type status --to ${fromId} "<reply>" ` + `(bus run) — or orchestra message ${fromId} "<reply>" on a legacy delivery-OFF run`\n  );']], tests: [T.peer], rig: true },
  { id: 'MC12', name: 'the delivery switch is back in BUS_MECHANISMS', edits: [[SW, "export const BUS_MECHANISMS: readonly BusMechanism[] = [\n  'wake',", "export const BUS_MECHANISMS: readonly BusMechanism[] = [\n  'delivery' as BusMechanism,\n  'wake',"]], tests: [T.sw, T.runs] },
  { id: 'MC13', name: "the old wire name 'delivery' still resolves to a mechanism", edits: [[SW, 'const WIRE_TO_MECHANISM: Record<BusMechanismWire, BusMechanism> = {\n  wake: \'wake\',', "const WIRE_TO_MECHANISM: Record<BusMechanismWire, BusMechanism> = {\n  delivery: 'wake' as BusMechanism,\n  wake: 'wake',"]], tests: [T.sw, T.runs] },
  { id: 'MC14', name: 'the memory alert filters out a run frozen without delivery (a deaf root again)', edits: [[ALERT, '  for (const r of liveFleetRuns(db, deps)) {\n    const run = getRun(db, r.id);', '  for (const r of liveFleetRuns(db, deps)) {\n    if ((r.flags as unknown as Record<string, unknown>).delivery !== true) continue;\n    const run = getRun(db, r.id);']], tests: [T.alert] },
  { id: 'MC15', name: 'the orchestra-comms skill teaches the legacy / delivery-ON channel again', edits: [[WS, 'is REFUSED for every peer; it prints the', 'is the legacy channel, refused on a delivery-ON run; it prints the']], tests: [T.skills] },
  { id: 'MC16', name: 'the orchestrator brief says "bus (delivery-ON) run … legacy channel" again', edits: [[WS, '(the bus is the only channel between agents: `orchestra message` is refused and points at `orchestra send`;', 'on a bus (delivery-ON) run (`orchestra message` is the legacy channel;']], tests: [T.skills] },
  { id: 'MC17', name: 'the mirror files a row in an invented per-boot host-<ts> run when the recipient has none', edits: [[MIRROR, "const runId = input.runId?.trim() ?? '';", 'const runId = input.runId?.trim() || mirrorRunId();']], tests: [T.gate] },
  { id: 'MC18', name: "the wake boot line reads the row-less 'default' run again", edits: [[WAKE, 'if (db) census = countOpenRuns(db, (id) => readWakeSwitch(id));', "if (db) census = { on: readWakeSwitch('default') ? 1 : 0, total: 1 };"]], tests: [T.wiring] },
  { id: 'MC19', name: "the liveness boot line reads the row-less 'default' run again", edits: [[LIVE, "if (db) census = openRunSwitchCount(db, 'liveness');", "if (db) census = { on: busSwitch(db, 'default', 'liveness') ? 1 : 0, total: 1 };"]], tests: [T.wiring] },
  { id: 'MC20', name: "the session-watchdog resolver defaults to the 'default' sentinel again", edits: [[DOG, 'let resolveRunId: (ws: Workspace) => string = realRunOf;', "let resolveRunId: (ws: Workspace) => string = () => 'default';"]], tests: [T.wiring] },
  { id: 'MC21', name: 'a plain-target exemption is back in the host wrapper (`message` to a top-level plain agent allowed)', cli: true, edits: [[WS, "  if (!gate.allow) {\n    return { ok: false, error: gate.error };\n  }\n", "  if (!gate.allow && (store.getWorkspace(input.to)?.parentId ?? '') !== '') {\n    return { ok: false, error: gate.error };\n  }\n"]], tests: [T.gate], rig: true },
  { id: 'MC22', name: 'the wrapper mirrors an --emergency poke onto the bus again (a stranger\'s poke becomes a row in the target\'s run)', cli: true, edits: [[WS, '  return dispatchMessageRequestUnmirrored(input);\n}', "  const res = await dispatchMessageRequestUnmirrored(input);\n  mirrorDispatch({ sender: input.from ?? 'external', recipient: input.to, body: input.text, result: res });\n  return res;\n}"]], tests: [T.gate, T.mirror], rig: true },
  { id: 'MC23', name: 'the refusal echo is capped again (a long text is silently cut inside the printed command)', cli: true, edits: [[WS, '    text: input.text.trim(),\n  });\n  if (!gate.allow) {', '    text: input.text.trim().slice(0, 8000),\n  });\n  if (!gate.allow) {']], tests: [T.gate], rig: true },
  { id: 'MC24', name: 'the target id is no longer quoted in the printed command', cli: true, edits: [[GATE, '${/^[\\w.:@/-]+$/.test(to) ? to : shellQuote(to)}', '${to}']], tests: [T.gate], rig: true },
  { id: 'MC25', name: 'the startup-notice OFF line names an old channel again', edits: [[SW, '=OFF — this mechanism is not active in this run; the bus only COUNTS', '=OFF — the OLD channel stays authoritative; the bus only COUNTS']], tests: [T.sw, T.runs] },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const count = (src, s) => src.split(s).length - 1;
function anchorsOk() {
  let bad = 0, total = 0;
  for (const m of MUTANTS) for (const [f, find] of m.edits) {
    total++;
    const n = count(fs.readFileSync(path.join(REPO, f), 'utf8'), find);
    if (n !== 1) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${f} matches ${n}× (need exactly 1): ${JSON.stringify(find.slice(0, 90))}`); }
  }
  console.log(`ANCHORS: ${total - bad}/${total} resolve exactly once`);
  return bad === 0;
}
if (args.includes('--check-anchors')) process.exit(anchorsOk() ? 0 : 1);
if (!anchorsOk()) process.exit(2);
const touched = [...new Set(MUTANTS.flatMap((m) => m.edits.map(([f]) => f)))];
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...touched]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'oldchan441-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 600000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: REPO, stdio: 'ignore', timeout: 300000 });
const rig = () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './scripts/.r2-register.mjs', 'scripts/e2e-old-channel-closed.mjs'], { cwd: REPO, encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { status: r.status, red: [...out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]), pass: /OLD CHANNEL CLOSED: ALL PASS/.test(out) };
};

{
  buildCli();
  const files = [...new Set(MUTANTS.flatMap((m) => m.tests ?? []))];
  const u = unit(files); const red = failedNames(u.stdout);
  const skipped = /^# skipped (\d+)/m.exec(u.stdout)?.[1];
  const g = rig();
  console.log(`CONTROL unmutated unit files (${files.length}): ${u.status === 0 && red.length === 0 && skipped === '0' ? 'GREEN, skipped 0' : `RED ${JSON.stringify(red)} skipped=${skipped} — INSTRUMENT BROKEN`}`);
  console.log(`CONTROL unmutated rig: ${g.pass ? 'ALL PASS (instrument can pass)' : `RED ${JSON.stringify(g.red)} — INSTRUMENT BROKEN`}`);
  if (u.status !== 0 || skipped !== '0' || !g.pass) process.exit(4);
}

const results = [];
let cliDirty = false;
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  files.forEach((f, i) => fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, `${m.id}-${i}.bak`)));
  const killedBy = [];
  let restored = false;
  try {
    for (const [f, find, to] of m.edits) {
      const p = path.join(REPO, f);
      const src = fs.readFileSync(p, 'utf8');
      if (count(src, find) !== 1) throw new Error(`PATTERN-GONE ${m.id} ${f}`);
      fs.writeFileSync(p, src.replace(find, () => to));
    }
    if (m.cli) { buildCli(); cliDirty = true; }
    if (m.tests?.length) {
      const u = unit(m.tests);
      const red = failedNames(u.stdout);
      if (u.status !== 0 || red.length) killedBy.push(`unit: ${red.length ? red.slice(0, 2).join(' | ') : `rc=${u.status}`}`);
    }
    if (m.rig) {
      const g = rig();
      if (!g.pass) killedBy.push(`rig: ${g.red.length ? g.red.join(',') : `rc=${g.status}`}`);
    }
  } finally {
    files.forEach((f, i) => fs.copyFileSync(path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)));
    restored = files.every((f, i) => sha(f) === before[f] && spawnSync('cmp', ['-s', path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)]).status === 0);
  }
  results.push({ id: m.id, name: m.name, killed: killedBy.length > 0, killedBy, restored });
  console.log(`${killedBy.length ? 'KILLED ' : 'SURVIVED'} ${m.id} ${m.name}${killedBy.length ? `\n         ← ${killedBy.join('\n         ← ')}` : ''}${restored ? '' : '\n         !! RESTORE FAILED'}`);
}
if (cliDirty) buildCli();
const survivors = results.filter((r) => !r.killed);
const unrestored = results.filter((r) => !r.restored);
const diff = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', ...touched], { encoding: 'utf8' }).stdout.trim();
console.log(`\nMUTANTS: ${results.length - survivors.length}/${results.length} killed; survivors: ${survivors.map((s) => s.id).join(', ') || 'none'}; restore: ${unrestored.length ? 'FAILED ' + unrestored.map((s) => s.id).join(',') : 'all byte-exact'}; git diff on touched files: ${diff || 'empty'}`);
process.exit(survivors.length === 0 && unrestored.length === 0 && !diff ? 0 : 1);
