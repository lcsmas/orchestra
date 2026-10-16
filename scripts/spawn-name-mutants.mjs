// #382 — mutate every changed clause of `orchestra spawn --name` ONCE, IN PLACE, and require the tests to go RED.
// Per mutant: byte backup -> `find` must occur exactly once -> replace -> (rebuild cli.js when asked) -> run the tests ->
// RED expected (rc != 0 AND the expected test name appears on a `not ok` line) -> restore -> `cmp` against the backup.
// A control run on the UNMUTATED tree must be green first (the instrument can say PASS), and the tree is rebuilt at the end.
// Usage: node scripts/spawn-name-mutants.mjs [mutant-id ...]      (run from the repo root; never on a tree you need intact)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'spawn-name-mut-'));
const F = {
  policy: 'src/shared/naming-policy.ts',
  ws: 'src/main/workspaces.ts',
  hooks: 'src/main/hooks-server.ts',
  sandbox: 'src/main/transport/sandbox-manager.ts',
  agentSdk: 'src/main/agent-sdk.ts',
  cli: 'src/cli/index.ts',
  linear: 'src/main/linear-tickets.ts',
  mobile: 'src/main/acces-mobile-routes.ts',
  cliGuide: 'docs/guide/cli.md',
};
const T = {
  unit: 'src/shared/naming-policy-spawn-name.test.ts',
  wiring: 'src/main/spawn-name-wiring.test.ts',
  cli: 'src/cli/spawn-name.test.ts',
  w381: 'src/main/naming-policy-wiring.test.ts',
  kinds: 'src/main/model-defaults-wiring.test.ts',
  help: 'src/cli/help.test.ts',
};
const ALL = Object.values(T);

/** id, file, find (exactly once), to, rebuild (cli.js), tests to run, `expect` = a substring of a failing test's name. */
const MUTANTS = [
  { id: 'M01_required_name', file: F.policy, find: "if (!given) return refuse('a spawn needs a name (--name): none given');", to: "if (given === '\\u0000') return refuse('a spawn needs a name (--name): none given');", tests: [T.unit], expect: 'required — must-FAIL' },
  { id: 'M02_role_prefix_loose', file: F.policy, find: 'name.startsWith(`${r}-`)', to: 'name.startsWith(r)', tests: [T.unit], expect: 'rôle prefix — must-FAIL' },
  { id: 'M03_object_not_required', file: F.policy, find: "if (!/[a-zA-Z0-9]/.test(name.slice(role.length + 1)))", to: "if (false)", tests: [T.unit], expect: 'object — must-FAIL' },
  { id: 'M04_not_sanitised', file: F.policy, find: 'const name = sanitizeBranchName(given);', to: 'const name = given;', tests: [T.unit], expect: 'sanitisation' },
  { id: 'M05_convention_not_restated', file: F.policy, find: '`${why} — expected ${NAME_CONVENTION}`', to: '`${why}`', tests: [T.unit, T.cli], expect: 'restates the convention' },
  { id: 'M06_nudge_ignores_namer', file: F.policy, find: ' && !ws.namedByParent &&', to: ' &&', tests: [T.unit, T.wiring], expect: 'nudgeActive — must-FAIL' },
  { id: 'M07_wrapper_skips_check', file: F.ws, find: "if (!checked.ok) return { ok: false, error: `refusing to spawn: ${checked.error}. Nothing was created.` };", to: '', tests: [T.wiring], expect: 'the AGENT route requires the name' },
  { id: 'M08_wrapper_no_namer', file: F.ws, find: "branch: checked.name, namedBy: input.from }", to: "branch: checked.name }", tests: [T.wiring, T.kinds], expect: 'AGENT route' },
  { id: 'M09_wrapper_raw_name', file: F.ws, find: "branch: checked.name, namedBy: input.from }", to: "branch: input.name ?? undefined, namedBy: input.from }", tests: [T.wiring, T.kinds], expect: 'AGENT route' },
  { id: 'M10_hooks_route_bypasses', file: F.hooks, find: 'await dispatchAgentSpawnRequest({', to: 'await dispatchSpawnRequest({ defaultKind: "spawned",', tests: [T.wiring, T.kinds], expect: 'hooks-server /spawn and the sandbox wire' },
  { id: 'M11_sandbox_route_bypasses', file: F.sandbox, find: 'await dispatchAgentSpawnRequest({', to: 'await dispatchSpawnRequest({ defaultKind: "spawned",', tests: [T.wiring, T.kinds], expect: 'hooks-server /spawn and the sandbox wire' },
  { id: 'M12_createWorkspace_drops_namer', file: F.ws, find: '...initialNaming({ namedBy: naming?.namedBy }),', to: '...initialNaming(),', tests: [T.wiring, T.w381], expect: 'createWorkspace' },
  { id: 'M13_dispatch_drops_namer', file: F.ws, find: '}, input.defaultKind, { namedBy: input.namedBy });', to: '}, input.defaultKind);', tests: [T.wiring], expect: 'D4 — dispatchSpawnRequest itself' },
  { id: 'M14_dispatch_invents_namer_from_from', file: F.ws, find: '}, input.defaultKind, { namedBy: input.namedBy });', to: '}, input.defaultKind, { namedBy: input.from });', tests: [T.wiring], expect: 'D4 — dispatchSpawnRequest itself' },
  { id: 'M15_cli_no_check', file: F.cli, find: 'if (!named.ok) fail(`refusing to spawn: ${named.error}\\nNothing was created.`);', to: '', rebuild: true, tests: [T.cli, T.wiring], expect: 'spawn refused' },
  { id: 'M16_cli_check_after_socket', file: F.cli, find: 'const named = checkSpawnName(rawName);\n      if (!named.ok) fail(`refusing to spawn: ${named.error}\\nNothing was created.`);', to: 'const named = { ok: true as const, name: rawName ?? "" };', rebuild: true, tests: [T.cli, T.wiring], expect: 'spawn refused' },
  { id: 'M17_cli_name_not_sent', file: F.cli, find: 'from: selfWorkspaceId(), name: named.name }', to: 'from: selfWorkspaceId() }', rebuild: true, tests: [T.cli, T.wiring], expect: 'a valid name is sent' },
  { id: 'M18_linear_passes_namer (D4)', file: F.linear, find: '      from,\n      detached: !from,', to: '      from,\n      namedBy: from,\n      detached: !from,', tests: [T.wiring], expect: 'D4 — the HUMAN paths' },
  { id: 'M19_mobile_passes_namer (D4)', file: F.mobile, find: "detached: true, defaultKind: 'workspace', origin: 'human' }", to: "detached: true, defaultKind: 'workspace', origin: 'human', namedBy: 'x' }", tests: [T.wiring], expect: 'D4 — the HUMAN paths' },
  { id: 'M20_hook_gate_open', file: F.ws, find: '[ "\\${ORCHESTRA_BRANCH_AUTO:-0}" = "1" ] || exit 0', to: 'true', tests: [T.wiring], expect: 'end to end' },
  { id: 'M21_env_always_on', file: F.agentSdk, find: "env.ORCHESTRA_BRANCH_AUTO = nudgeActive(ws) ? '1' : '0';", to: "env.ORCHESTRA_BRANCH_AUTO = '1';", tests: [T.wiring, T.w381], expect: 'derives ORCHESTRA_BRANCH_AUTO' },
  { id: 'M24_no_diacritic_fold', file: F.policy, find: "    .normalize('NFD')\n    .replace(/\\p{M}+/gu, '')\n", to: '\n', tests: [T.unit], expect: 'diacritics — must-PASS' },
  { id: 'M25_slash_allowed', file: F.policy, find: "if (name.includes('/')) return", to: "if (false) return", tests: [T.unit], expect: 'flat' },
  { id: 'M26_length_unbounded', file: F.policy, find: 'if (name.length > MAX_SPAWN_NAME) return', to: 'if (false) return', tests: [T.unit], expect: 'length' },
  { id: 'M27_git_ref_unchecked', file: F.policy, find: 'if (/\\.\\.|\\.$|\\.lock$/.test(name)) return', to: 'if (false) return', tests: [T.unit], expect: 'git ref' },
  { id: 'M28_origin_rides_agent_route', file: F.ws, find: "'defaultKind' | 'branch' | 'namedBy' | 'origin'>", to: "'defaultKind' | 'branch' | 'namedBy'>", tests: [T.wiring], expect: 'the AGENT route requires the name' },
  { id: 'M22_guide_drops_name', file: F.cliGuide, find: 'orchestra spawn --name <name> --task <text>', to: 'orchestra spawn --task <text>', tests: [T.wiring], expect: 'G10' },
  { id: 'M23_help_drops_convention', file: 'src/cli/help.ts', find: '(required): ${NAME_CONVENTION}.', to: '(required).', tests: [T.wiring], expect: 'G10' },
];

const only = process.argv.slice(2);
const run = (tests) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...tests], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
const build = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: ROOT, stdio: 'pipe' });
const failedNames = (out) => [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const count = (s, sub) => s.split(sub).length - 1;

console.log(`root ${ROOT}\nbackups ${TMP}`);
build();
const control = run(ALL);
const ctlFail = failedNames(control.stdout);
console.log(`CONTROL (unmutated): rc ${control.status}, tests ${/# tests (\d+)/.exec(control.stdout)?.[1]}, pass ${/# pass (\d+)/.exec(control.stdout)?.[1]}, skipped ${/# skipped (\d+)/.exec(control.stdout)?.[1]}, not-ok ${ctlFail.length}`);
if (control.status !== 0 || ctlFail.length) { console.log('ABORT: the unmutated tree is not green — a mutant result would mean nothing'); process.exit(2); }

const rows = [];
for (const m of MUTANTS) {
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
    if (m.rebuild) build();
    const r = run(m.tests);
    const names = failedNames(r.stdout);
    const hit = names.find((n2) => n2.includes(m.expect));
    verdict = r.status !== 0 && hit ? 'RED' : r.status !== 0 ? 'RED-ELSEWHERE' : 'GREEN(!)';
    detail = `rc ${r.status}; failing: ${names.length ? names.slice(0, 3).join(' | ').slice(0, 220) : '(none)'}${verdict === 'RED-ELSEWHERE' ? ` — expected "${m.expect}"` : ''}`;
  } finally {
    fs.writeFileSync(abs, orig);
    const same = Buffer.compare(fs.readFileSync(abs), fs.readFileSync(backup)) === 0;
    if (!same) { console.log(`FATAL: ${m.file} not restored byte-exact`); process.exit(3); }
    if (m.rebuild) build();
    rows.push({ id: m.id, verdict, restored: 'cmp-identical', detail });
    console.log(`${verdict.padEnd(14)} ${m.id.padEnd(40)} ${detail}`);
  }
}
const git = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: ROOT, encoding: 'utf8' }).stdout;
const after = run(ALL);
console.log(`\nRESTORED TREE: rc ${after.status}, not-ok ${failedNames(after.stdout).length}\nSUMMARY: ${rows.filter((r) => r.verdict === 'RED').length}/${rows.length} RED`);
console.log(rows.filter((r) => r.verdict !== 'RED').map((r) => `  NOT RED: ${r.id} (${r.verdict}) ${r.detail}`).join('\n'));
process.exit(rows.every((r) => r.verdict === 'RED') && after.status === 0 ? 0 : 1);
