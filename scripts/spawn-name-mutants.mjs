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
  lock: 'src/shared/keyed-lock.ts',
  help: 'src/cli/help.ts',
  readme: 'README.md',
  slotsSrc: 'src/shared/branch-slots.ts',
};
const T = {
  unit: 'src/shared/naming-policy-spawn-name.test.ts',
  wiring: 'src/main/spawn-name-wiring.test.ts',
  cli: 'src/cli/spawn-name.test.ts',
  w381: 'src/main/naming-policy-wiring.test.ts',
  kinds: 'src/main/model-defaults-wiring.test.ts',
  helpTest: 'src/cli/help.test.ts',
  race: 'src/main/spawn-name-race.test.ts',
  pins: 'src/main/spawn-docs-pins.test.ts',
  lockTest: 'src/shared/keyed-lock.test.ts',
  slots: 'src/shared/branch-slots.test.ts',
};
const ALL = Object.values(T);

/** id, file, find (exactly once), to, rebuild (cli.js), tests to run, `expect` = a substring of a failing test's name. */
const MUTANTS = [
  { id: 'M01_required_name', file: F.policy, find: "if (!given) return refuse('a spawn needs a name (--name): none given');", to: "if (given === '\\u0000') return refuse('a spawn needs a name (--name): none given');", tests: [T.unit], expect: 'required — must-FAIL' },
  { id: 'M02_role_prefix_loose', file: F.policy, find: 'name.startsWith(`${r}-`)', to: 'name.startsWith(r)', tests: [T.unit], expect: 'rôle prefix — must-FAIL' },
  { id: 'M03_object_not_required', file: F.policy, find: "if (!/[a-zA-Z0-9]/.test(name.slice(role.length + 1)))", to: "if (false)", tests: [T.unit], expect: 'object — must-FAIL' },
  { id: 'M04_not_sanitised', file: F.policy, find: 'const name = sanitizeBranchName(folded);', to: 'const name = folded;', tests: [T.unit], expect: 'sanitisation' },
  { id: 'M05_convention_not_restated', file: F.policy, find: '`${why} — expected ${NAME_CONVENTION}`', to: '`${why}`', tests: [T.unit, T.cli], expect: 'restates the convention' },
  { id: 'M06_nudge_ignores_namer', file: F.policy, find: ' && !ws.namedByParent &&', to: ' &&', tests: [T.unit, T.wiring], expect: 'nudgeActive — must-FAIL' },
  { id: 'M07_wrapper_skips_check', file: F.ws, find: "if (!checked.ok) return { ok: false, error: `refusing to spawn: ${checked.error}. Nothing was created.` };", to: '', tests: [T.wiring], expect: 'the AGENT route requires the name' },
  { id: 'M08_wrapper_no_namer', file: F.ws, find: "branch: checked.name, namedBy: input.from, exactName: true }", to: "branch: checked.name, exactName: true }", tests: [T.wiring, T.kinds], expect: 'AGENT route' },
  { id: 'M09_wrapper_raw_name', file: F.ws, find: "branch: checked.name, namedBy: input.from, exactName: true }", to: "branch: input.name ?? undefined, namedBy: input.from, exactName: true }", tests: [T.wiring, T.kinds], expect: 'AGENT route' },
  { id: 'M10_hooks_route_bypasses', file: F.hooks, find: 'await dispatchAgentSpawnRequest({', to: 'await dispatchSpawnRequest({ defaultKind: "spawned",', tests: [T.wiring, T.kinds], expect: 'hooks-server /spawn and the sandbox wire' },
  { id: 'M11_sandbox_route_bypasses', file: F.sandbox, find: 'await dispatchAgentSpawnRequest({', to: 'await dispatchSpawnRequest({ defaultKind: "spawned",', tests: [T.wiring, T.kinds], expect: 'hooks-server /spawn and the sandbox wire' },
  { id: 'M12_createWorkspace_drops_namer', file: F.ws, find: '...initialNaming({ namedBy: naming?.namedBy }),', to: '...initialNaming(),', tests: [T.wiring, T.w381], expect: 'createWorkspace' },
  { id: 'M13_dispatch_drops_namer', file: F.ws, find: '}, input.defaultKind, { namedBy: input.namedBy, exactName: input.exactName });', to: '}, input.defaultKind, { exactName: input.exactName });', tests: [T.wiring], expect: 'D4 — dispatchSpawnRequest itself' },
  { id: 'M14_dispatch_invents_namer_from_from', file: F.ws, find: '}, input.defaultKind, { namedBy: input.namedBy, exactName: input.exactName });', to: '}, input.defaultKind, { namedBy: input.from, exactName: input.exactName });', tests: [T.wiring], expect: 'D4 — dispatchSpawnRequest itself' },
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
  { id: 'M28_origin_rides_agent_route', file: F.ws, find: "'defaultKind' | 'branch' | 'namedBy' | 'exactName' | 'origin'>", to: "'defaultKind' | 'branch' | 'namedBy' | 'exactName'>", tests: [T.wiring], expect: 'the AGENT route requires the name' },
  // ── #382 follow-up: refuse stray positionals, pin the docs promise, serialise branch allocation, refuse an exhausted exact name ──
  { id: 'M30_cli_leftovers_ignored', file: F.cli, find: 'if (r5.length)\n        fail(', to: 'if (false)\n        fail(', rebuild: true, tests: [T.cli], expect: 'stray argument' },
  { id: 'M31_cli_usage_without_name', file: F.cli, find: "'usage: orchestra spawn --name <name> --task <text>", to: "'usage: orchestra spawn --task <text>", rebuild: true, tests: [T.cli], expect: 'usage line with --name first' },
  { id: 'M32_help_usage_without_name', file: F.help, find: 'detail: `usage: orchestra spawn --name <name> --task', to: 'detail: `usage: orchestra spawn --task', tests: [T.pins], expect: 'CLI help' },
  { id: 'M33_brief_MUST_to_MAY', file: F.ws, find: 'Every spawn MUST carry', to: 'Every spawn MAY carry', tests: [T.pins], expect: 'orchestrator brief' },
  { id: 'M34_brief_sentence_deleted', file: F.ws, find: "  `Every spawn MUST carry \\`--name\\`: the child is named \\`${NAME_CONVENTION}\\` — you name it (the child is not asked to rename itself), no wave codes in the name. `;", to: "  '';", tests: [T.pins], expect: 'orchestrator brief' },
  { id: 'M35_skill_required_header_deleted', file: F.ws, find: '**Name the child — \\`--name\\` is REQUIRED.**', to: 'Name the child.', tests: [T.pins], expect: 'REQUIRED' },
  { id: 'M36_skill_refusal_sentence', file: F.ws, find: 'is REFUSED and creates', to: 'is accepted and creates', tests: [T.pins], expect: 'REQUIRED' },
  { id: 'M37_skill_placeholder_unquoted', file: F.ws, find: '--name "ops-<milestone-in-human-words>"', to: '--name ops-<milestone en mots humains>', tests: [T.pins], expect: 'valid shell' },
  { id: 'M38_rename_skill_description_qualifier', file: F.ws, find: ' NOT for an agent spawned by another agent — its parent named it.', to: '', tests: [T.pins], expect: 'orchestra-rename skill' },
  { id: 'M39_rename_skill_body_note', file: F.ws, find: 'If another agent spawned you, your branch was named by that agent', to: 'Your branch was named', tests: [T.pins], expect: 'orchestra-rename skill' },
  { id: 'M40_readme_bullet_without_name', file: F.readme, find: '`orchestra spawn --name impl-sidebar-lent-123 --task "…"`', to: '`orchestra spawn --task "…"`', tests: [T.pins], expect: 'README' },
  { id: 'M41_readme_cli_line_without_name', file: F.readme, find: 'orchestra spawn --name <name> --task <text> [--repo <path>]', to: 'orchestra spawn --task <text> [--repo <path>]', tests: [T.pins], expect: 'README' },
  { id: 'M42_allocation_lock_removed', file: F.ws, find: 'const branchAllocation = createKeyedLock();', to: 'const branchAllocation = { run: <T>(_k: string, f: () => Promise<T>) => f() };', tests: [T.race, T.wiring], expect: 'race:' },
  { id: 'M43_exact_name_never_refuses', file: F.ws, find: 'if (requested && !free && naming?.exactName) {', to: 'if (false) {', tests: [T.race, T.wiring], expect: 'exhausted' },
  { id: 'M44_wrapper_drops_exactName', file: F.ws, find: "namedBy: input.from, exactName: true });", to: "namedBy: input.from });", tests: [T.race, T.wiring, T.kinds], expect: 'exhausted' },
  { id: 'M45_dispatch_drops_exactName', file: F.ws, find: '{ namedBy: input.namedBy, exactName: input.exactName });', to: '{ namedBy: input.namedBy });', tests: [T.race, T.wiring], expect: 'exhausted' },
  { id: 'M46_checkout_inside_the_lock', file: F.ws, find: "    taken.add(chosen); // visible to the next pick BEFORE the lock is released\n    return chosen;", to: "    taken.add(chosen);\n    await createWorktree(input.repoPath, chosen, baseBranch, path.join(ORCHESTRA_ROOT, `${repoName}-${chosen}-${id.slice(0, 8)}`));\n    return chosen;", tests: [T.wiring], expect: 'branch-NAME pick' },
  { id: 'M47_lock_not_fifo', file: F.lock, find: '      await prev;\n', to: '', tests: [T.lockTest, T.race], expect: 'same key' },
  { id: 'M48_lock_leaks_keys', file: F.lock, find: 'if (tails.get(key) === tail) tails.delete(key);', to: '', tests: [T.lockTest], expect: 'same key' },
  // ── review of the follow-up: real-path key, reservation (checkout outside the lock), folder conflicts, valueless options ──
  { id: 'M49_lock_key_is_the_raw_path', file: F.ws, find: 'const repoKey = await realpath(input.repoPath).catch(() => input.repoPath);', to: 'const repoKey = input.repoPath;', tests: [T.race, T.wiring], expect: 'alias:' },
  { id: 'M50_pick_not_reserved', file: F.ws, find: 'taken.add(chosen); // visible to the next pick BEFORE the lock is released', to: '', tests: [T.race, T.wiring], expect: 'race:' },
  { id: 'M51_reservation_never_released', file: F.ws, find: 'taken.delete(branch); // created ⇒ git now holds the name; failed ⇒ the name is free again', to: '', tests: [T.race, T.wiring], expect: 'released:' },
  { id: 'M52_agent_route_ignores_folder_conflicts', file: F.ws, find: 'avoidFolders: naming?.exactName === true', to: 'avoidFolders: false', tests: [T.race, T.wiring], expect: 'folder:' },
  { id: 'M53_free_branch_name_drops_options', file: F.ws, find: 'return freeBranchSlot(await listBranches(repoPath), desired, current, opts);', to: 'return freeBranchSlot(await listBranches(repoPath), desired, current);', tests: [T.race, T.wiring], expect: 'freeBranchName delegates' },
  { id: 'M54_slots_folder_rule_dead', file: F.slotsSrc, find: '(opts.avoidFolders === true && [...taken].some((b) => b.startsWith(`${name}/`)))', to: 'false', tests: [T.slots, T.race], expect: 'avoidFolders' },
  { id: 'M55_slots_ignore_reserved', file: F.slotsSrc, find: 'for (const r of opts.reserved ?? []) taken.add(r);', to: '', tests: [T.slots, T.race], expect: 'reserved names' },
  { id: 'M56_slots_off_by_one', file: F.slotsSrc, find: 'n <= MAX_BRANCH_SUFFIX', to: 'n < MAX_BRANCH_SUFFIX', tests: [T.slots], expect: 'no options' },
  { id: 'M57_cli_valueless_option_swallowed', file: F.cli, find: "if (i !== -1 && (args[i + 1] === undefined || args[i + 1].startsWith('--')))", to: 'if (false)', rebuild: true, tests: [T.cli], expect: 'option without a value' },
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
