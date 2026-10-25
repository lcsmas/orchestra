// #401 — mutate every clause of `orchestra spawn --profile` ONCE, IN PLACE, and require the tests (tier unit) / the built-app rig (tier app) to go RED.
// Per mutant: byte backup -> `find` must occur exactly once -> replace -> (rebuild when asked) -> run -> RED expected (rc != 0 AND the expected
// test/clause name on a `not ok` / `FAIL` line) -> restore -> `cmp` against the backup. A control run on the UNMUTATED tree must be green first.
// Usage: node scripts/spawn-profile-mutants.mjs [--tier unit|app|all] [mutant-id-prefix ...]     (repo root; never on a tree you need intact)
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
  { id: 'U3_dangling_id_trusted', file: F.pure, find: 'input.profiles.find((p) => p.id === heldId);', to: 'input.profiles.find((p) => p.id === heldId) ?? { id: heldId, name: heldId, createdAt: 0 };', tests: [T.unit], expect: 'dangling id' },
  { id: 'U4_vouch_removed', file: F.pure, find: 'if (!input.callerVouched) {', to: 'if (false) {', tests: [T.unit], expect: 'unvouched:' },
  { id: 'U5_no_caller_not_checked', file: F.pure, find: 'if (!input.caller) {', to: 'if (false) {', tests: [T.unit], expect: 'no caller:' },
  { id: 'U6_name_match_case_sensitive', file: F.pure, find: "requested.toLowerCase() === held.name.toLowerCase()", to: 'requested === held.name', tests: [T.unit], expect: 'by NAME' },
  { id: 'U7_blank_read_as_none', file: F.pure, find: "if (input.requested === undefined) return { kind: 'none' };", to: "if (!input.requested) return { kind: 'none' };", tests: [T.unit], expect: 'blank value is refused' },
  { id: 'U8_ephemeral_wording_dropped', file: F.pure, find: "const EPHEMERAL = 'The worker starts in navigation éphémère.';", to: "const EPHEMERAL = '';", tests: [T.unit], expect: 'every refusal says' },
  { id: 'U9_message_names_the_unheld_profile', file: F.pure, find: 'not ${JSON.stringify(requested.slice(0, 40))}', to: 'not ${JSON.stringify(requested.slice(0, 40))} (${input.profiles.map((p) => p.name).join(", ")})', tests: [T.unit], expect: 'no existence oracle' },
  // ── CLI ──
  { id: 'C1_profile_not_sent', file: F.cli, find: 'body.profile = profile;', to: '', rebuild: true, tests: [T.cli], expect: 'POSTs profile=P' },
  { id: 'C2_key_not_sent', file: F.cli, find: 'if (key) body.key = key;', to: '', rebuild: true, tests: [T.cli], expect: 'POSTs profile=P' },
  { id: 'C3_valueless_profile_swallowed', file: F.cli, find: "for (const f of ['--task', '--repo', '--base', '--model', '--effort', '--profile']) {", to: "for (const f of ['--task', '--repo', '--base', '--model', '--effort']) {", rebuild: true, tests: [T.cli], expect: 'no value' },
  { id: 'C4_warning_swallowed', file: F.cli, find: 'else process.stderr.write(`warning: ${passed.message}\\n`);', to: '', rebuild: true, tests: [T.cli], expect: 'a refused pass' },
  { id: 'C5_usage_without_profile', file: F.cli, find: "[--effort <level>] [--profile <id|name>] [--detached]',", to: "[--effort <level>] [--detached]',", rebuild: true, tests: [T.cli], expect: 'usage text' },
  { id: 'C6_whoami_row_wrong', file: F.cli, find: ": 'ephemeral'))(res.browserProfile", to: ": 'none'))(res.browserProfile", rebuild: true, tests: [T.cli], expect: 'whoami prints' },
  // ── host wiring ──
  { id: 'W1_caller_read_from_the_request', file: F.ws, find: 'caller: input.from ? store.getWorkspace(input.from) : undefined,', to: 'caller: { browserProfileId: input.profile },', tests: [T.wiring], expect: 'decides from the LIVE records' },
  { id: 'W2_vouch_bypassed', file: F.ws, find: "callerVouched: !!input.from && !!input.key && sessionKeys().verify(input.from, input.key) === 'ok',", to: 'callerVouched: true,', tests: [T.wiring], expect: 'decides from the LIVE records' },
  { id: 'W3_unhonoured_profile_written', file: F.ws, find: "profileDecision.kind === 'honoured' ? { browserProfileId: profileDecision.profileId } : undefined);", to: 'input.profile ? { browserProfileId: input.profile } : undefined);', tests: [T.wiring], expect: 'only an honoured one' },
  { id: 'W4_record_write_dropped', file: F.ws, find: '...(inherited?.browserProfileId ? { browserProfileId: inherited.browserProfileId } : {}),', to: '', tests: [T.wiring], expect: 'createWorkspace writes browserProfileId' },
  { id: 'W5_route_drops_key', file: F.hooks, find: "key: typeof msg.key === 'string' ? msg.key : undefined,", to: '', tests: [T.wiring], expect: 'only the hooks /spawn route' },
  { id: 'W6_route_drops_profile', file: F.hooks, find: "profile: typeof msg.profile === 'string' ? msg.profile : undefined,", to: '', tests: [T.wiring], expect: 'only the hooks /spawn route' },
  { id: 'W7_sandbox_wire_carries_a_profile', file: F.sandbox, find: "name: typeof p.name === 'string' ? p.name : undefined,", to: "name: typeof p.name === 'string' ? p.name : undefined, profile: 'x',", tests: [T.wiring], expect: 'only the hooks /spawn route' },
  { id: 'W8_create_input_gains_a_profile', file: F.types, find: 'export interface CreateWorkspaceInput {', to: 'export interface CreateWorkspaceInput {\n  browserProfileId?: string;', tests: [T.wiring], expect: 'createWorkspace writes browserProfileId' },
  { id: 'W9_spawn_touches_the_attach_service', file: F.ws, find: 'const profileDecision = decideSpawnProfile({', to: '// browserProfileAttach\n  const profileDecision = decideSpawnProfile({', tests: [T.wiring], expect: 'never touches the human-only attach' },
  { id: 'W10_whoami_reads_the_raw_record', file: F.ws, find: 'const heldId = effectiveProfileId(ws.browserProfileId, profiles);', to: 'const heldId = ws.browserProfileId;', tests: [T.wiring], expect: 'whoami exposes the HELD profile' },
  { id: 'W11_report_lost_on_a_failed_start', file: F.ws, find: 'return { ...keptFailure(ws.id, ws.branch, started.error), ...profileReport };', to: 'return keptFailure(ws.id, ws.branch, started.error);', tests: [T.wiring], expect: 'the reply carries the decision' },
  // ── built app (rig): each must turn the NAMED clause RED while the controls (ctl/*, a0/*) stay green ──
  { id: 'A1_holds_check_removed (rig)', tier: 'app', file: F.pure, find: "if (requested === held.id || (requested !== '' && requested.toLowerCase() === held.name.toLowerCase())) {", to: 'if (true) {', arms: 'a2', expect: ['a2/record-has-no-profile', 'a2/refused-worker-panel-is-ephemeral'] },
  { id: 'A2_vouch_removed (rig)', tier: 'app', file: F.pure, find: 'if (!input.callerVouched) {', to: 'if (false) {', arms: 'a5', expect: ['a5/no-session-key-is-refused', 'a5/another-sessions-key-is-refused'] },
  { id: 'A3_record_write_dropped (rig)', tier: 'app', file: F.ws, find: '...(inherited?.browserProfileId ? { browserProfileId: inherited.browserProfileId } : {}),', to: '', arms: 'a1', expect: ['a1/record-carries-the-profile', 'a1/worker-panel-is-signed-in-as-the-parent'] },
  { id: 'A4_route_drops_profile (rig)', tier: 'app', file: F.hooks, find: "profile: typeof msg.profile === 'string' ? msg.profile : undefined,", to: '', arms: 'a1', expect: ['a1/record-carries-the-profile', 'a1/worker-panel-is-signed-in-as-the-parent'] },
  { id: 'A5_cli_drops_key (rig)', tier: 'app', file: F.cli, find: 'if (key) body.key = key;', to: '', rebuild: true, arms: 'a1', expect: ['a1/record-carries-the-profile', 'a1/worker-panel-is-signed-in-as-the-parent'] },
];

const run = (tests) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...tests], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: ROOT, stdio: 'pipe' });
const buildBundles = () => execFileSync('pnpm', ['run', 'build:bundles'], { cwd: ROOT, stdio: 'pipe' });
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
    if (tier === 'app') {
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
