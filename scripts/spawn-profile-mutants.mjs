// #401 — mutate every clause of `orchestra spawn --profile` ONCE, IN PLACE, and require the tests (tier unit) / the built-app rig (tier app) to go RED.
// Per mutant: byte backup -> `find` must occur exactly once -> replace -> (rebuild when asked) -> run -> RED expected (rc != 0 AND the expected
// test/clause name on a `not ok` / `FAIL` line) -> restore -> `cmp` against the backup. A control run on the UNMUTATED tree must be green first.
// Tiers: unit (node --test) · host (Electron-free real-dispatch harness scripts/verify-spawn-profile-host.mjs, incl. the M1 TOCTOU hold) · app (built-app rig, GUI).
// Usage: node scripts/spawn-profile-mutants.mjs [--tier unit|host|app|all] [mutant-id-prefix ...]     (repo root; never on a tree you need intact)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const tierArg = args.includes('--tier') ? args[args.indexOf('--tier') + 1] : 'unit';
const only = args.filter((a, i) => a !== '--tier' && args[i - 1] !== '--tier');
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'spawn-profile-mut-'));
const F = {
  pure: 'src/shared/spawn-profile.ts', ws: 'src/main/workspaces.ts', hooks: 'src/main/hooks-server.ts', sandbox: 'src/main/transport/sandbox-manager.ts',
  cli: 'src/cli/index.ts', types: 'src/shared/types.ts',
};
const T = { unit: 'src/shared/spawn-profile.test.ts', wiring: 'src/main/spawn-profile-wiring.test.ts', cli: 'src/cli/spawn-profile.test.ts' };
const ALL = Object.values(T);

/** id, file, find (exactly once), to, rebuild (cli.js), tests, `expect` = substring of a failing test name — OR tier 'app' with `arms` + `expect` = a rig clause name. */
const MUTANTS = [
  // ── pure rule ──
  { id: 'U1_holds_check_removed', file: F.pure, find: "if (requested === held.id || (requested !== '' && requested.toLowerCase() === held.name.toLowerCase())) {", to: 'if (true) {', tests: [T.unit], expect: 'does not hold: the caller holds ANOTHER' },
  { id: 'U2_holds_none_not_checked', file: F.pure, find: 'if (!held) {', to: 'if (false) {', tests: [T.unit], expect: 'the caller has no profile' },
  // (a first U3 only added a fallback AFTER effectiveProfileId — an equivalent mutant, GREEN; this one trusts the recorded id itself)
  { id: 'U3_dangling_id_trusted', file: F.pure, find: 'const heldId = effectiveProfileId(input.caller.browserProfileId, input.profiles);\n  const held = heldId === undefined ? undefined : input.profiles.find((p) => p.id === heldId);', to: 'const heldId = input.caller.browserProfileId;\n  const held = heldId === undefined ? undefined : { id: heldId, name: heldId, createdAt: 0 };', tests: [T.unit], expect: 'dangling id' },
  { id: 'U4_vouch_removed', file: F.pure, find: 'if (!input.callerVouched) {', to: 'if (false) {', tests: [T.unit], expect: 'unvouched:' },
  { id: 'U5_no_caller_not_checked', file: F.pure, find: 'if (!input.caller) {', to: 'if (false) {', tests: [T.unit], expect: 'no caller:' },
  { id: 'U6_name_match_case_sensitive', file: F.pure, find: "requested.toLowerCase() === held.name.toLowerCase()", to: 'requested === held.name', tests: [T.unit], expect: 'by NAME' },
  { id: 'U7_blank_read_as_none', file: F.pure, find: "if (input.requested === undefined) return { kind: 'none' };", to: "if (!input.requested) return { kind: 'none' };", tests: [T.unit], expect: 'blank value is refused' },
  { id: 'U8_ephemeral_wording_dropped', file: F.pure, find: "const EPHEMERAL = 'The worker starts in navigation éphémère.';", to: "const EPHEMERAL = '';", tests: [T.unit], expect: 'every refusal says' },
  { id: 'U9_message_names_the_unheld_profile', file: F.pure, find: 'not ${JSON.stringify(requested.slice(0, 40))}', to: 'not ${JSON.stringify(requested.slice(0, 40))} (${input.profiles.map((p) => p.name).join(", ")})', tests: [T.unit], expect: 'no existence oracle' },
  { id: 'U10_message_leaks_profile_ids', file: F.pure, find: 'not ${JSON.stringify(requested.slice(0, 40))}', to: 'not ${JSON.stringify(requested.slice(0, 40))} (${input.profiles.map((p) => p.id).join(", ")})', tests: [T.unit], expect: 'no existence oracle' },
  { id: 'U11_detached_ignored', file: F.pure, find: 'if (input.detached) {', to: 'if (false) {', tests: [T.unit], expect: 'detached:' },
  // ── CLI ──
  { id: 'C1_profile_not_sent', file: F.cli, find: 'body.profile = profile;', to: '', rebuild: true, tests: [T.cli], expect: 'POSTs profile=P' },
  { id: 'C2_key_not_sent', file: F.cli, find: 'if (key) body.key = key;', to: '', rebuild: true, tests: [T.cli], expect: 'POSTs profile=P' },
  { id: 'C3_valueless_profile_swallowed', file: F.cli, find: "for (const f of ['--task', '--repo', '--base', '--model', '--effort', '--profile']) {", to: "for (const f of ['--task', '--repo', '--base', '--model', '--effort']) {", rebuild: true, tests: [T.cli], expect: 'no value' },
  { id: 'C4_warning_swallowed', file: F.cli, find: 'else process.stderr.write(`warning: ${passed.message}\\n`);', to: '', rebuild: true, tests: [T.cli], expect: 'a refused pass' },
  { id: 'C5_usage_without_profile', file: F.cli, find: "[--effort <level>] [--profile <id|name>] [--detached]',", to: "[--effort <level>] [--detached]',", rebuild: true, tests: [T.cli], expect: 'usage text' },
  { id: 'C6_whoami_row_wrong', file: F.cli, find: ": 'ephemeral'))(res.browserProfile", to: ": 'none'))(res.browserProfile", rebuild: true, tests: [T.cli], expect: 'whoami prints' },
  { id: 'C7_kept_child_profile_unreported', file: F.cli, find: "if (typeof res.id === 'string') reportProfile();", to: '', rebuild: true, tests: [T.cli], expect: 'a kept child' },
  { id: 'C8_old_app_silence_unwarned', file: F.cli, find: '} else if (profile !== undefined) {', to: '} else if (false) {', rebuild: true, tests: [T.cli], expect: 'predates it' },
  // ── host wiring ──
  { id: 'W12_detached_not_passed_to_the_rule', file: F.ws, find: 'detached: input.detached === true,', to: 'detached: false,', tests: [T.wiring], expect: 'decides from the LIVE records' },
  { id: 'W1_caller_read_from_the_request', file: F.ws, find: 'caller: input.from ? store.getWorkspace(input.from) : undefined,', to: 'caller: { browserProfileId: input.profile },', tests: [T.wiring], expect: 'decides from the LIVE records' },
  { id: 'W2_vouch_bypassed', file: F.ws, find: "callerVouched: !!input.from && !!input.key && sessionKeys().verify(input.from, input.key) === 'ok',", to: 'callerVouched: true,', tests: [T.wiring], expect: 'decides from the LIVE records' },
  { id: 'W3_unhonoured_profile_written', file: F.ws, find: "return profileDecision.kind === 'honoured' ? profileDecision.profileId : undefined;", to: 'return input.profile;', tests: [T.wiring], expect: 'returns the id only when honoured' },
  { id: 'W4_record_write_dropped', file: F.ws, find: '...(inheritedProfile ? { browserProfileId: inheritedProfile } : {}),', to: '', tests: [T.wiring], expect: 'createWorkspace writes browserProfileId' },
  { id: 'W5_route_drops_key', file: F.hooks, find: "key: typeof msg.key === 'string' ? msg.key : undefined,", to: '', tests: [T.wiring], expect: 'only the hooks /spawn route' },
  { id: 'W6_route_drops_profile', file: F.hooks, find: "profile: typeof msg.profile === 'string' ? msg.profile : undefined,", to: '', tests: [T.wiring], expect: 'only the hooks /spawn route' },
  { id: 'W7_sandbox_wire_carries_a_profile', file: F.sandbox, find: "name: typeof p.name === 'string' ? p.name : undefined,", to: "name: typeof p.name === 'string' ? p.name : undefined, profile: 'x',", tests: [T.wiring], expect: 'only the hooks /spawn route' },
  { id: 'W8_create_input_gains_a_profile', file: F.types, find: 'export interface CreateWorkspaceInput {', to: 'export interface CreateWorkspaceInput {\n  browserProfileId?: string;', tests: [T.wiring], expect: 'createWorkspace writes browserProfileId' },
  { id: 'W9_spawn_touches_the_attach_service', file: F.ws, find: 'profileDecision = decideSpawnProfile({', to: '// browserProfileAttach\n    profileDecision = decideSpawnProfile({', tests: [T.wiring], expect: 'never touches the human-only attach' },
  { id: 'W10_whoami_reads_the_raw_record', file: F.ws, find: 'const heldId = effectiveProfileId(ws.browserProfileId, profiles);', to: 'const heldId = ws.browserProfileId;', tests: [T.wiring], expect: 'whoami shows the HELD profile' },
  { id: 'W11_report_lost_on_a_failed_start', file: F.ws, find: '...profileReport(), // #401: a kept child still says what became of its profile', to: '', tests: [T.wiring], expect: 'the reply carries the decision' },
  { id: 'W13_thunk_asked_after_an_await', file: F.ws, find: 'const inheritedProfile = profileAtCreation?.(); // sync, last read before the record is built and upserted (no await between)', to: 'const inheritedProfile = profileAtCreation?.();\n  await Promise.resolve();', tests: [T.wiring], expect: 'M1 TOCTOU' },
  { id: 'W14_whoami_vouch_removed', file: F.ws, find: "const vouched = !!input.key && sessionKeys().verify(id, input.key) === 'ok';", to: 'const vouched = true;', tests: [T.wiring], expect: 'whoami shows the HELD profile only' },
  { id: 'W15_whoami_route_drops_key', file: F.hooks, find: "dispatchWhoamiRequest({ id: msg.id, key: typeof msg.key === 'string' ? msg.key : undefined })", to: 'dispatchWhoamiRequest({ id: msg.id })', tests: [T.wiring], expect: 'whoami shows the HELD profile only' },
  { id: 'C9_whoami_cli_drops_key', file: F.cli, find: "{ id, ...(whoamiKey ? { key: whoamiKey } : {}) }", to: '{ id }', rebuild: true, tests: [T.cli], expect: 'whoami sends the session key' },
  { id: 'C10_whoami_unvouched_reads_ephemeral', file: F.cli, find: "p === undefined ? '(not vouched)'", to: "p === undefined ? 'ephemeral'", rebuild: true, tests: [T.cli], expect: 'whoami prints the held profile' },
  // ── host harness (real workspaces.ts, no GUI): `expect` = clause ids (the first token after FAIL); the control clause t1 must stay green ──
  { id: 'X1_decision_made_early_and_kept (stale t0)', tier: 'host', file: F.ws, find: 'input.profile !== undefined ? decideProfile : undefined);', to: 'input.profile !== undefined ? ((d) => () => d)(decideProfile()) : undefined);', expect: ['t2', 't3', 't4', 't5', 't6'] },
  { id: 'X2_whoami_vouch_dropped', tier: 'host', file: F.ws, find: "const vouched = !!input.key && sessionKeys().verify(id, input.key) === 'ok';", to: 'const vouched = true;', expect: ['w2'] },
  { id: 'X3_whoami_null_when_unvouched', tier: 'host', file: F.ws, find: "...(vouched ? { browserProfile: held ? { id: held.id, name: held.name } : null } : {}),", to: '...{ browserProfile: held ? { id: held.id, name: held.name } : null },', expect: ['w2'] },
  { id: 'X4_spawn_vouch_dropped', tier: 'host', file: F.ws, find: "callerVouched: !!input.from && !!input.key && sessionKeys().verify(input.from, input.key) === 'ok',", to: 'callerVouched: true,', expect: ['h4', 't5'] },
  { id: 'X5_detached_not_passed', tier: 'host', file: F.ws, find: 'detached: input.detached === true,', to: 'detached: false,', expect: ['h3'] },
  { id: 'X6_request_written_not_the_held_id', tier: 'host', file: F.ws, find: "return profileDecision.kind === 'honoured' ? profileDecision.profileId : undefined;", to: 'return input.profile;', expect: ['h1', 'h2'] },
  { id: 'X7_report_dropped_on_success', tier: 'host', file: F.ws, find: "...(started.held ? { held: started.held } : {}), ...profileReport() };", to: '...(started.held ? { held: started.held } : {}) };', expect: ['h1', 'h2', 'h3', 'h4', 't2'], controlMayFail: true /* t1 asserts the success report too */ },
  // ── built app (rig): each must turn the NAMED clause RED while the controls (ctl/*, a0/*) stay green ──
  { id: 'A1_holds_check_removed (rig)', tier: 'app', file: F.pure, find: "if (requested === held.id || (requested !== '' && requested.toLowerCase() === held.name.toLowerCase())) {", to: 'if (true) {', arms: 'a2', expect: ['a2/record-has-no-profile', 'a2/refused-worker-panel-is-ephemeral'] },
  { id: 'A2_vouch_removed (rig)', tier: 'app', file: F.pure, find: 'if (!input.callerVouched) {', to: 'if (false) {', arms: 'a5', expect: ['a5/no-session-key-is-refused', 'a5/another-sessions-key-is-refused'] },
  { id: 'A3_record_write_dropped (rig)', tier: 'app', file: F.ws, find: '...(inheritedProfile ? { browserProfileId: inheritedProfile } : {}),', to: '', arms: 'a1', expect: ['a1/record-carries-the-profile', 'a1/worker-panel-is-signed-in-as-the-parent'] },
  { id: 'A4_route_drops_profile (rig)', tier: 'app', file: F.hooks, find: "profile: typeof msg.profile === 'string' ? msg.profile : undefined,", to: '', arms: 'a1', expect: ['a1/record-carries-the-profile', 'a1/worker-panel-is-signed-in-as-the-parent'] },
  { id: 'A6_detached_ignored (rig)', tier: 'app', file: F.pure, find: 'if (input.detached) {', to: 'if (false) {', arms: 'a4', expect: ['a4/detached-worker-gets-no-profile'] },
  { id: 'A7_unheld_profile_written_from_the_request (rig)', tier: 'app', file: F.ws, find: "return profileDecision.kind === 'honoured' ? profileDecision.profileId : undefined;", to: 'return input.profile;', arms: 'a6', expect: ['a6/hostile-body-creates-a-new-workspace-without-the-unheld-profile'] },
  { id: 'A8_superseded_key_accepted (rig)', tier: 'app', file: F.ws, find: "sessionKeys().verify(input.from, input.key) === 'ok',", to: "sessionKeys().verify(input.from, input.key) !== 'unregistered',", arms: 'a5,a7', expect: ['a7/superseded-session-key-is-refused', 'a5/another-sessions-key-is-refused'] },
  { id: 'A5_cli_drops_key (rig)', tier: 'app', file: F.cli, find: 'if (key) body.key = key;', to: '', rebuild: true, arms: 'a1', expect: ['a1/record-carries-the-profile', 'a1/worker-panel-is-signed-in-as-the-parent'] },
];

const run = (tests) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...tests], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: ROOT, stdio: 'pipe' });
const buildBundles = () => execFileSync('pnpm', ['run', 'build:bundles'], { cwd: ROOT, stdio: 'pipe' });
const host = () => spawnSync(process.execPath, ['--experimental-strip-types', '--import', './scripts/.r2-register.mjs', 'scripts/verify-spawn-profile-host.mjs', '.'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 5 * 60_000 });
const failedHostIds = (out) => [...out.matchAll(/^ {2}FAIL (\S+) /gm)].map((m) => m[1]);
const rig = (arms) => spawnSync('nice', ['-n', '10', path.join(ROOT, 'scripts/e2e-spawn-profile.sh'), ROOT, '--arms', arms], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 25 * 60_000 });
const failedNames = (out) => [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const failedClauses = (out) => [...out.matchAll(/^ {2}FAIL {2}(\S+) — /gm)].map((m) => m[1]);
const passedClauses = (out) => [...out.matchAll(/^ {2}PASS {2}(\S+) — /gm)].map((m) => m[1]);
const count = (s, sub) => s.split(sub).length - 1;

console.log(`root ${ROOT}\nbackups ${TMP}\ntier ${tierArg}`);
buildCli();
const control = run(ALL);
const ctlFail = failedNames(control.stdout);
console.log(`CONTROL (unmutated): rc ${control.status}, tests ${/# tests (\d+)/.exec(control.stdout)?.[1]}, pass ${/# pass (\d+)/.exec(control.stdout)?.[1]}, skipped ${/# skipped (\d+)/.exec(control.stdout)?.[1]}, not-ok ${ctlFail.length}`);
if (control.status !== 0 || ctlFail.length) { console.log('ABORT: the unmutated tree is not green — a mutant result would mean nothing'); process.exit(2); }

const ctlHost = tierArg === 'unit' ? null : host();
if (ctlHost) {
  const f = failedHostIds(ctlHost.stdout);
  console.log(`CONTROL (host harness, unmutated): rc ${ctlHost.status}, ${/(\d+\/\d+) clauses PASS/.exec(ctlHost.stdout)?.[1] ?? 'no summary'}, FAIL ${f.length}`);
  if (ctlHost.status !== 0) { console.log('ABORT: the unmutated host harness is not green'); process.exit(2); }
}
const rows = [];
for (const m of MUTANTS) {
  const tier = m.tier ?? 'unit';
  if (tierArg !== 'all' && tier !== tierArg) continue;
  if (only.length && !only.some((o) => m.id.startsWith(o))) continue;
  const abs = path.join(ROOT, m.file);
  const orig = fs.readFileSync(abs);
  const backup = path.join(TMP, `${m.id.replace(/\W+/g, '_')}.bak`);
  fs.writeFileSync(backup, orig);
  let verdict = 'ERROR', detail = '';
  try {
    const text = orig.toString('utf8');
    const n = count(text, m.find);
    if (n !== 1) { detail = `find occurs ${n}× (need exactly 1)`; continue; }
    fs.writeFileSync(abs, text.replace(m.find, () => m.to));
    if (Buffer.compare(fs.readFileSync(abs), orig) === 0) { detail = 'mutation changed nothing'; continue; }
    if (tier === 'host') {
      const r = host();
      const fails = failedHostIds(r.stdout);
      const hit = m.expect.every((e) => fails.includes(e));
      verdict = r.status !== 0 && hit && (m.controlMayFail || !fails.includes('t1')) ? 'RED' : r.status !== 0 ? 'RED-ELSEWHERE' : 'GREEN(!)';
      detail = `host rc ${r.status}; FAIL [${fails.join(', ') || 'none'}]; expected [${m.expect.join(', ')}]; control t1 ${fails.includes('t1') ? 'FAILED' : 'green'}`;
    } else if (tier === 'app') {
      buildBundles();
      const r = rig(m.arms);
      const fails = failedClauses(r.stdout), passes = passedClauses(r.stdout);
      const hit = m.expect.every((e) => fails.includes(e));
      const controlsGreen = passes.includes('a0/parent-signed-in-instrument-says-yes') && fails.every((f) => m.expect.includes(f) || m.arms.split(',').some((a) => f.startsWith(`${a}/`)));
      verdict = r.status !== 0 && hit && controlsGreen ? 'RED' : r.status !== 0 ? 'RED-ELSEWHERE' : 'GREEN(!)';
      detail = `rig rc ${r.status}; FAIL [${fails.join(', ') || 'none'}]; expected [${m.expect.join(', ')}]; a0 control ${passes.includes('a0/parent-signed-in-instrument-says-yes') ? 'PASS' : 'NOT PASS'}`;
    } else {
      if (m.rebuild) buildCli();
      const r = run(m.tests);
      const names = failedNames(r.stdout);
      const hit = names.find((n2) => n2.includes(m.expect));
      verdict = r.status !== 0 && hit ? 'RED' : r.status !== 0 ? 'RED-ELSEWHERE' : 'GREEN(!)';
      detail = `rc ${r.status}; failing: ${names.length ? names.slice(0, 3).join(' | ').slice(0, 220) : '(none)'}${verdict === 'RED-ELSEWHERE' ? ` — expected "${m.expect}"` : ''}`;
    }
  } finally {
    fs.writeFileSync(abs, orig);
    const same = Buffer.compare(fs.readFileSync(abs), fs.readFileSync(backup)) === 0;
    if (!same) { console.log(`FATAL: ${m.file} not restored byte-exact`); process.exit(3); }
    rows.push({ id: m.id, verdict, detail });
    console.log(`${verdict.padEnd(14)} ${m.id.padEnd(42)} ${detail}`);
  }
}
buildBundles();
const after = run(ALL);
console.log(`\nRESTORED TREE (rebuilt): rc ${after.status}, not-ok ${failedNames(after.stdout).length}, git: ${spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).length} dirty path(s)`);
console.log(`SUMMARY: ${rows.filter((r) => r.verdict === 'RED').length}/${rows.length} RED`);
console.log(rows.filter((r) => r.verdict !== 'RED').map((r) => `  NOT RED: ${r.id} (${r.verdict}) ${r.detail}`).join('\n'));
process.exit(rows.every((r) => r.verdict === 'RED') && after.status === 0 ? 0 : 1);
