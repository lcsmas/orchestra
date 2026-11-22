#!/usr/bin/env node
// #538 rig — the frozen-test writer's brief names the repo's own INTEGRATION HARNESS, through the BUILT CLI (dist-electron/cli.js) against a FAKE HOST on a unix socket running the REAL
// host half (src/shared/fanout-acceptance-host.ts + fanout-harness*.ts, loaded from SHARED_DIR) over scratch git repos. Light: no Electron, no network, no tokens, scratch under $TMPDIR.
//   node scripts/e2e-fanout-harness-brief.mjs            baseline: every arm must PASS
//   node scripts/e2e-fanout-harness-brief.mjs --mutants  each patched copy of the BUILT bundle / of src/shared must be KILLED (≥1 arm FAILs); the baseline is the control
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const SHARED = path.join(ROOT, 'src', 'shared');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const SELF = 'as self-contained files (they import the production code by path; no helper, config or fixture outside the files you freeze)';

// The fake host: the REAL dispatchFanoutAcceptance behind a unix socket. Tickets named N-* are written against repo N (no harness), every other ticket against repo A (a Nest-like harness).
const HOST_JS = `
import http from 'node:http'; import fs from 'node:fs';
const { dispatchFanoutAcceptance } = await import(process.env.SHARED_DIR + '/fanout-acceptance-host.ts');
const log = (o) => fs.appendFileSync(process.env.HOST_LOG, JSON.stringify(o) + '\\n');
let n = 0;
const deps = { home: process.env.ORCHESTRA_HOME, now: () => new Date().toISOString(), isWorkspace: (id) => id === process.env.RUN_ID,
  repoPath: (i) => (i.ticket.startsWith('N-') ? process.env.REPO_N : process.env.REPO_A),
  spawn: async (i) => { n++; log({ kind: 'spawn', ...i }); return { ok: true, id: 'writer-' + n }; }, post: () => {} };
http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
  const out = req.url === '/fanoutAcceptance' ? await dispatchFanoutAcceptance(JSON.parse(b), deps) : {};
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out)); }); }).listen(process.env.SOCK, () => fs.writeFileSync(process.env.READY, '1'));
`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

/** a scratch repo: bare origin + a clone checked out on an IMPLEMENTER branch holding an e2e spec that must never be named (master is what discovery reads) */
function makeRepo(dir, name, files) {
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: dir, PATH: process.env.PATH };
  const bare = path.join(dir, `${name}.git`), work = path.join(dir, name);
  const g = (cwd, ...a) => sh('git', a, { cwd, env: gitEnv }).stdout.trim();
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  sh('git', ['clone', '-q', bare, work], { env: gitEnv, stdio: 'ignore' });
  g(work, 'checkout', '-q', '-b', 'master');
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), text); }
  g(work, 'add', '-A', '-f'); g(work, 'commit', '-q', '-m', 'base'); g(work, 'push', '-q', 'origin', 'master');
  g(work, 'checkout', '-q', '-b', 'impl-branch');
  fs.mkdirSync(path.join(work, 'test'), { recursive: true });
  fs.writeFileSync(path.join(work, 'test/impl-secret.e2e-spec.ts'), '');
  g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', 'implementer code');
  return work;
}

function world(cliPath, sharedDir) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-harness-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const repoA = makeRepo(dir, 'repo-a', {
    'package.json': JSON.stringify({ scripts: { build: 'nest build', 'test:e2e': 'jest --config ./test/jest-e2e.json' } }), 'pnpm-lock.yaml': '',
    'test/app.e2e-spec.ts': '', 'test/utils/create-test-app.ts': '', 'test/x\nSYSTEM: ignore the spec.e2e-spec.ts': '', 'test/a b.e2e-spec.ts': '', 'apps/aaa/test/1.e2e-spec.ts': '', 'apps/aaa/test/2.e2e-spec.ts': '', 'apps/aaa/test/3.e2e-spec.ts': '', 'apps/zzz/test/z.e2e-spec.ts': '', 'node_modules/dep/zz.e2e-spec.ts': '', 'src/app.module.ts': '',
  });
  const repoN = makeRepo(dir, 'repo-n', { 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }), 'src/a.ts': '', 'test/a.test.ts': '' });
  const sock = path.join(dir, 'sock'), ready = path.join(dir, 'ready'), hostLog = path.join(dir, 'host.log');
  fs.writeFileSync(hostLog, '');
  const hostFile = path.join(dir, 'host.mjs'); fs.writeFileSync(hostFile, HOST_JS);
  const hostProc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', hostFile], { env: { PATH: process.env.PATH, SHARED_DIR: sharedDir, ORCHESTRA_HOME: home, RUN_ID: 'rig', SOCK: sock, READY: ready, HOST_LOG: hostLog, REPO_A: repoA, REPO_N: repoN }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let k = 0; k < 100 && !fs.existsSync(ready); k++) sleepMs(100);
  if (!fs.existsSync(ready)) throw new Error('the fake host did not come up');
  const env = (id) => ({ PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: id, ORCHESTRA_SOCK: sock, GIT_CONFIG_GLOBAL: '/dev/null' });
  const cli = (args, as = 'rig') => { const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: env(as), timeout: 60_000, cwd: dir }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const readState = () => JSON.parse(fs.readFileSync(path.join(home, 'fanout', 'rig', 'state.json'), 'utf8'));
  const spawns = () => fs.readFileSync(hostLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'spawn');
  const register = (ticket) => cli(['fanout', 'state', 'set', ticket, '--run', 'rig', '--spec', `docs/spec.md#${ticket}`, '--implementer', 'impl-1', '--verifier', 'verif-1']);
  return { dir, cli, readState, spawns, register, kill: () => { hostProc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function scenarios(cliPath, sharedDir) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const J = (r) => `${r.code} ${r.stdout}${r.stderr}`.slice(0, 500);
  const W = world(cliPath, sharedDir);
  const both = (b) => /boot the FULL application module through that harness/.test(b) && /OWN execution context per test/.test(b) && /never share one across tests, never reuse one the app already released/.test(b);
  const task = (i) => W.spawns()[i]?.task ?? '';
  return (async () => {
    try {
      // ── declared ────────────────────────────────────────────────────────────────────────────────────────
      const init = W.cli(['fanout', 'state', 'init', '--run', 'rig', '--repo', 'o/r', '--harness', 'pnpm run test:e2e — test/utils/create-test-app.ts']);
      arm('D1 must-PASS `state init --harness` records it (state.json) and `state show` prints it', init.code === 0 && W.readState().harness === 'pnpm run test:e2e — test/utils/create-test-app.ts' && /harness \(#538\): pnpm run test:e2e — test\/utils\/create-test-app\.ts/.test(W.cli(['fanout', 'state', 'show', '--run', 'rig']).stdout), J(init));
      const r1 = W.register('T-1');
      arm('D2 must-PASS declared: the writer\'s brief NAMES the declared harness and carries BOTH requirements (full-module boot, per-test execution context)', r1.code === 0 && W.spawns().length === 1 && /DECLARED by the coordinator in the fanout state\): pnpm run test:e2e — test\/utils\/create-test-app\.ts\./.test(task(0)) && both(task(0)) && /`--run-cmd` is still a DIRECT runner call/.test(task(0)) && /freeze the closest allowlisted call you can run, or do not freeze/.test(task(0)), `${J(r1)} | ${task(0).slice(0, 700)}`);
      arm('D3 must-PASS declared BEATS discovered: repo A has an e2e spec + fixture, none of them is named, nothing says FOUND', !/FOUND by Orchestra/.test(task(0)) && !/test\/app\.e2e-spec\.ts/.test(task(0)), task(0).slice(0, 600));
      arm('D4 must-PASS with a harness the self-contained line is replaced by "the harness is the one allowed import"; the blind-writer + freeze lines are untouched', !task(0).includes(SELF) && /import the production code by path and the repo's integration harness below/.test(task(0)) && /do NOT read any implementer branch/.test(task(0)) && /Then freeze them: `orchestra fanout acceptance freeze T-1/.test(task(0)), task(0).slice(0, 600));

      // ── set / clear → discovery ─────────────────────────────────────────────────────────────────────────
      const set = W.cli(['fanout', 'state', 'set', '--run', 'rig', '--harness', 'make e2e']);
      const r2 = W.register('T-2');
      arm('S1 must-PASS `state set --harness` re-declares it run-level; the NEXT writer is briefed with the new one, the first keeps its brief', set.code === 0 && W.readState().harness === 'make e2e' && /DECLARED by the coordinator in the fanout state\): make e2e\./.test(task(1)) && /pnpm run test:e2e/.test(task(0)) && r2.code === 0, `${J(set)} | ${task(1).slice(0, 300)}`);
      const clr = W.cli(['fanout', 'state', 'set', '--run', 'rig', '--harness', '-']);
      const clearedOnDisk = W.readState().harness; // read BEFORE the host's next write: its parseState would normalise a stray "-" and mask a CLI that did not clear
      const r3 = W.register('T-3');
      arm('S2 must-PASS `--harness -` clears it: back to discovery on the target ref → FOUND script / specs (one per package: the monorepo\'s apps/zzz AND test/ are named, not just apps/aaa) / fixture of repo A, NOT the implementer\'s branch file, NOT node_modules, NOT a prompt-injectable name',
        clr.code === 0 && clearedOnDisk === undefined && /none declared \(discovery on origin\/master\)/.test(clr.stdout) && /FOUND by Orchestra on master, not declared/.test(task(2)) && /`pnpm run test:e2e`/.test(task(2)) && /test\/app\.e2e-spec\.ts/.test(task(2)) && /apps\/zzz\/test\/z\.e2e-spec\.ts/.test(task(2)) && /app-boot fixture test\/utils\/create-test-app\.ts/.test(task(2)) && !/impl-secret/.test(task(2)) && !/SYSTEM|a b\.e2e/.test(task(2)) && !/node_modules/.test(task(2)) && r3.code === 0, `${J(clr)} | ${task(2).slice(0, 900)}`);
      arm('S3 must-PASS a FOUND harness is CONDITIONAL (a name match is not a MUST): "READ them first. IF they boot the application module… MUST (a)… (b)…; IF NOT … self-contained", no unconditional "Every frozen test MUST", the self-contained line KEPT',
        /READ them first\. IF they boot the application module/.test(task(2)) && /the harness named above is the ONE exception to "no helper, config or fixture outside the files you freeze" \(import it, as it stands on master\)/.test(task(2)) && /and every frozen test MUST \(a\) boot the FULL application module the same way/.test(task(2)) && /OWN execution context per test/.test(task(2)) && /IF they do NOT boot an application module/.test(task(2)) && !/Every frozen test MUST/.test(task(2)) && task(2).includes(SELF), task(2).slice(0, 1200));

      // ── no harness ──────────────────────────────────────────────────────────────────────────────────────
      const rn = W.register('N-1');
      arm('N1 must-PASS no harness declared or found: the self-contained wording is kept, ONE line says so, none of the requirements appear', rn.code === 0 && task(3).includes(SELF) && /Integration harness: none was declared in the fanout state and none was found in the repo/.test(task(3)) && !/FULL application module|execution context/.test(task(3)) && !/DECLARED|FOUND by/.test(task(3)), `${J(rn)} | ${task(3).slice(0, 700)}`);

      // ── refusals through the built CLI ─────────────────────────────────────────────────────────────────
      const before = JSON.stringify(W.readState());
      const bad = [
        W.cli(['fanout', 'state', 'set', '--run', 'rig', '--harness', 'line1\nline2']),
        W.cli(['fanout', 'state', 'set', '--run', 'rig', '--harness', 'x'.repeat(301)]),
        W.cli(['fanout', 'state', 'set', 'T-1', '--run', 'rig', '--harness', 'x']),
        W.cli(['fanout', 'state', 'set', '--run', 'rig', '--harness', 'x', '--status', 'started']),
      ];
      arm('X1 must-FAIL a multi-line / over-long harness, a ticket + --harness, --harness + another flag: every one exits non-zero naming harness; the state is untouched', bad.every((r) => r.code !== 0 && /harness/.test(r.stderr)) && JSON.stringify(W.readState()) === before, bad.map(J).join(' || '));
      const badInit = W.cli(['fanout', 'state', 'init', '--run', 'rig2', '--harness', 'a\nb']);
      arm('X2 must-FAIL `state init --harness` with a control char is refused and writes no state.json', badInit.code !== 0 && /harness/.test(badInit.stderr) && !fs.existsSync(path.join(W.dir, 'home', 'fanout', 'rig2', 'state.json')), J(badInit));

      // ── compat: nothing declared = no key at all ──────────────────────────────────────────────────────────
      const plain = W.cli(['fanout', 'state', 'init', '--run', 'rig3']);
      const plainRaw = JSON.parse(fs.readFileSync(path.join(W.dir, 'home', 'fanout', 'rig3', 'state.json'), 'utf8'));
      arm('C1 must-PASS a state that declares no harness has NO `harness` key (an older binary refuses unknown keys; never written as null)', plain.code === 0 && !('harness' in plainRaw), J(plain) + JSON.stringify(plainRaw).slice(0, 200));

      // ── help text ──────────────────────────────────────────────────────────────────────────────────────
      const h1 = W.cli(['fanout', 'acceptance', '--help']);
      const h2 = W.cli(['fanout', 'state']);
      arm('H1 must-PASS `fanout acceptance --help` carries the harness line AND the residue note says the harness is not hashed; `fanout state` usage lists --harness',
        /Harness \(#538\)/.test(h1.stdout + h1.stderr) && /integration harness, #538 — NOT hashed either/.test(h1.stdout + h1.stderr) && /state init --run <id>.*--harness <ref>/.test(h2.stdout + h2.stderr) && /--harness <ref>\s+\(#538\)/.test(h2.stdout + h2.stderr), `${(h1.stdout + h1.stderr).slice(0, 200)} | ${(h2.stdout + h2.stderr).slice(0, 200)}`);
    } catch (e) {
      arm('rig crashed: the arm sequence broke (a mutant that breaks the flow upstream lands here)', false, String(e?.stack ?? e).slice(0, 800));
    } finally { W.kill(); }
    return res;
  })();
}

async function run(title, cliPath, sharedDir) {
  const res = await scenarios(cliPath, sharedDir);
  console.log(`\n== ${title}`);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(`-- ${res.length - bad}/${res.length} PASS`);
  return bad;
}

// Each mutant breaks ONE clause (in the BUILT bundle, or in a scratch copy of src/shared for the host half); the anchor must occur exactly once.
const BUNDLE_MUTANTS = [
  { name: 'init: --harness is ignored', find: 'harness: p.vals["--harness"], now: deps.now() });', put: () => 'now: deps.now() });' },
  { name: 'set: "-" no longer clears the declared harness', find: 'if (s === "" || s === "-") return null;', put: () => 'if (s === "") return null;' },
  { name: 'set: a control char / newline in the harness is accepted', find: 'if (s.length > 300 || /[\\x00-\\x1f\\x7f]/.test(s)) throw', put: () => 'if (false) throw' },
  { name: 'set: the 300-char bound is gone', find: 'if (s.length > 300 || /[\\x00-\\x1f\\x7f]/.test(s)) throw', put: () => 'if (/[\\x00-\\x1f\\x7f]/.test(s)) throw' },
  { name: 'state writer: a state with no harness is written with `"harness": null` (older binaries refuse the key)', find: '...withHarness(harnessOf(raw.harness)),', put: () => 'harness: harnessOf(raw.harness),' },
  { name: 'set --harness: accepted together with a ticket or another flag (run-level rule off)', find: 'if (ticket || Object.keys(p.vals).some((k) => k !== "--harness" && k !== "--run")) throw', put: () => 'if (false) throw' },
  { name: 'show: the declared harness is not printed', find: 'const harnessLine = s.harness ?', put: () => 'const harnessLine = false ?' },
  { name: 'help: `fanout acceptance --help` loses the harness line', find: 'Harness (#538): the writer\'s brief names', put: () => 'The writer\'s brief names' },
  { name: 'help: the residue note forgets that the harness is not hashed', find: 'integration harness, #538 — NOT hashed either', put: () => 'integration harness, #538' },
];
const HOST_MUTANTS = [
  { file: 'fanout-acceptance-host.ts', name: 'host: a declared harness does not beat discovery (the repo is read first)', find: "if (declared.source === 'declared') return declared;", put: () => 'if (false) return declared;' },
  { file: 'fanout-acceptance-host.ts', name: 'host: the state\'s harness is never read (discovery only)', find: 'const declared = resolveHarness(state.harness, null);', put: () => 'const declared = resolveHarness(null, null);' },
  { file: 'fanout-acceptance.ts', name: 'brief: with no harness the self-contained wording is replaced too', find: "const withHarness = h !== null && h.source === 'declared';", put: () => 'const withHarness = true;' },
  { file: 'fanout-acceptance.ts', name: 'brief: a FOUND harness replaces the self-contained line too', find: "const withHarness = h !== null && h.source === 'declared';", put: () => "const withHarness = h !== null && h.source !== 'none';" },
  { file: 'fanout-harness.ts', name: 'brief: a FOUND harness\'s IF-boots case contradicts the kept "no helper outside the frozen files" line (exception clause dropped)', find: 'then the harness named above is the ONE exception to "no helper, config or fixture outside the files you freeze" (import it, as it stands on ${target}), and every frozen test MUST', put: () => 'then every frozen test MUST' },
  { file: 'fanout-harness.ts', name: 'brief: a FOUND harness is a hard MUST on a name match (MAJOR-1)', find: "if (h.source === 'declared') {\n    return [", put: () => 'if (true) {\n    return [' },
  { file: 'fanout-harness.ts', name: 'discovery: the specs cap is taken alphabetically over the whole tree (monorepo spread off)', find: 'const specs = spreadByRoot(files.filter((f) => SPEC_BY_NAME.test(f) || SPEC_BY_DIR.test(f)), MAX_SPECS);', put: () => 'const specs = files.filter((f) => SPEC_BY_NAME.test(f) || SPEC_BY_DIR.test(f)).slice(0, MAX_SPECS);' },
  { file: 'fanout-acceptance.ts', name: 'brief: a harness is named but the self-contained line is kept (the harness import contradicts it)', find: 'withHarness\n      ?', put: () => 'false\n      ?' },
  { file: 'fanout-harness.ts', name: 'brief: a DECLARED harness loses the per-test execution-context requirement', find: '(b) open its OWN execution context per test — its own DB connection / query runner / transaction, created in that test\'s setup and released in its teardown: never share one across tests, never reuse one the app already released.`,\n      imp,', put: () => '.`,\n      imp,' },
  { file: 'fanout-harness.ts', name: 'brief: a FOUND harness loses the per-test execution-context requirement', find: '(b) open its OWN execution context per test — its own DB connection / query runner / transaction, created in that test\'s setup and released in its teardown: never share one across tests, never reuse one the app already released. IF they do NOT', put: () => '. IF they do NOT' },
  { file: 'fanout-harness.ts', name: 'brief: the full-module-boot requirement is dropped', find: '(a) boot the FULL application module through that harness, exactly as the repo\'s existing integration specs do — never a hand-assembled module or a cherry-picked provider list (it passes alone and fails once tickets compose on ${target});', put: () => '(a) use that harness;' },
  { file: 'fanout-harness.ts', name: 'brief: no harness found → the one explanatory line is missing', find: "if (h.source === 'none') {", put: () => "if (h.source === 'none') { return [];" },
  { file: 'fanout-harness.ts', name: 'brief: a discovered harness is passed off as DECLARED', find: 'FOUND by Orchestra on ${target}, not declared — read it before you rely on it', put: () => 'DECLARED by the coordinator in the fanout state' },
  { file: 'fanout-harness.ts', name: 'discovery: a tracked file name with a newline / space goes into the prompt unsanitised', find: 'const files = facts.files.filter((f) => !IGNORED.test(f) && SAFE_NAME.test(f)).sort();', put: () => 'const files = facts.files.filter((f) => !IGNORED.test(f)).sort();' },
  { file: 'fanout-harness.ts', name: 'brief: the --run-cmd-stays-a-direct-runner note is dropped', find: "the candidate's). ${RUN_CMD_NOTE}`", put: () => "the candidate's).`" },
  { file: 'fanout-harness.ts', name: 'discovery: node_modules paths are not ignored', find: 'const files = facts.files.filter((f) => !IGNORED.test(f) && SAFE_NAME.test(f)).sort();', put: () => 'const files = facts.files.filter((f) => SAFE_NAME.test(f)).sort();' },
  { file: 'fanout-harness.ts', name: 'discovery: the package.json scripts are not read (no `pnpm run test:e2e`)', find: '.filter(([name]) => SCRIPT_NAME.test(name) && SAFE_NAME.test(name))', put: () => '.filter(() => false)' },
  { file: 'fanout-harness.ts', name: 'discovery: the app-boot fixture is not looked for', find: 'const fixtures = files.filter((f) => FIXTURE_NAME.test(baseNoExt(f)) && !specs.includes(f)).slice(0, MAX_FIXTURES);', put: () => 'const fixtures = [];' },
  { file: 'fanout-harness-facts.ts', name: 'discovery: reads the implementer\'s WORKTREE (ls-files) instead of the target ref', find: "const list = git(['ls-tree', '-r', '--name-only', '-z', ref]);", put: () => "const list = git(['ls-files', '-z']);" },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('harness (#538)')) { console.error('dist-electron/cli.js has no #538 harness support — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = await run('baseline (built bundle + src/shared)', CLI, SHARED);
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-harness-mut-'));
const only = process.env.MUT_ONLY?.split(',');
for (const [i, m] of BUNDLE_MUTANTS.entries()) {
  if (only && !only.includes(`b${i}`)) continue;
  const n = orig.split(m.find).length - 1;
  if (n !== 1) { console.error(`MUTANT b${i} "${m.name}": anchor found ${n}× (needs exactly 1) — the bundle shape changed, fix the rig`); process.exit(1); }
  const file = path.join(scratch, `mutant-b${i}.js`);
  fs.writeFileSync(file, orig.replace(m.find, () => m.put()));
  const bad = await run(`MUTANT b${i}: ${m.name}`, file, SHARED);
  console.log(bad > 0 ? `   → KILLED (${bad} arm(s) red)` : '   → SURVIVED (no arm noticed it)');
  if (bad === 0) survived++;
}
for (const [i, m] of HOST_MUTANTS.entries()) {
  if (only && !only.includes(`h${i}`)) continue;
  const dst = path.join(scratch, `shared-h${i}`);
  fs.cpSync(SHARED, dst, { recursive: true, filter: (s) => !/\.test\.ts$/.test(s) });
  const f = path.join(dst, m.file);
  const text = fs.readFileSync(f, 'utf8');
  const n = text.split(m.find).length - 1;
  if (n !== 1) { console.error(`MUTANT h${i} "${m.name}": anchor found ${n}× in ${m.file} (needs exactly 1)`); process.exit(1); }
  fs.writeFileSync(f, text.replace(m.find, () => m.put()));
  const bad = await run(`MUTANT h${i}: ${m.name}`, CLI, dst);
  console.log(bad > 0 ? `   → KILLED (${bad} arm(s) red)` : '   → SURVIVED (no arm noticed it)');
  if (bad === 0) survived++;
}
fs.rmSync(scratch, { recursive: true, force: true });
if (fs.readFileSync(CLI, 'utf8') !== orig) { console.error('the real bundle changed during the run'); process.exit(1); }
console.log(`\n${BUNDLE_MUTANTS.length + HOST_MUTANTS.length - survived}/${BUNDLE_MUTANTS.length + HOST_MUTANTS.length} mutants killed; real bundle byte-identical`);
process.exit(survived ? 1 : 0);
