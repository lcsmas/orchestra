// #332 — source-binding gate for the keeper's leaf layout (the keeper daemon cannot load under `node --test`): every hop of «keeper in k, CLI + tools in w, the cap and the watch on w» is wired.
// The leaf builder's order and failure handling are proven in member-leaves.test.ts; the real scope end to end in scripts/e2e-memory-cap.mjs (`session_survives_chain`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const keeper = readFileSync(path.join(here, 'index.ts'), 'utf8');
const setup = keeper.slice(keeper.indexOf('function setupMemoryCap('), keeper.indexOf('\n}\n', keeper.indexOf('function setupMemoryCap(')));
const startChild = keeper.slice(keeper.indexOf('function startChild('), keeper.indexOf('\n}\n', keeper.indexOf('function startChild(')));

test('CONTROL: the slices are the real functions', () => {
  assert.match(setup, /startMemoryWatch\(\{/);
  assert.match(startChild, /spawn\(command, args,/);
});

test('the scope\'s leaves are built by THIS keeper, from its own pid, after the scope was identified (leaf k maps back to the scope on a repeat call)', () => {
  assert.match(setup, /const inKeeperLeaf = !!cgPath && path\.basename\(cgPath\) === SCOPE_LEAF_KEEPER;/);
  assert.match(setup, /const scopePath = cgPath \? scopePathOfCgroup\(cgPath\) : null;/);
  assert.match(setup, /buildMemberLeaves\(\{ scopeDir: path\.join\(CGROUP_ROOT, scopePath\), hardBytes: cap\.hardBytes, pid: process\.pid, fs: realLeafFs, alreadyInKeeperLeaf: inKeeperLeaf \}\)/);
  const checkAt = setup.indexOf('path.basename(scopePath) !== cap.unit');
  assert.ok(checkAt > 0 && checkAt < setup.indexOf('buildMemberLeaves('), 'the scope is verified to be OURS before anything is created or moved');
});

test('leaves that could not be built ⇒ state not-applied, said in the log, NO watch (return before it) — but the tools stay wrapped (adj 1000: a backstop episode takes a tool, not the session)', () => {
  const failed = setup.slice(setup.indexOf('if (!leaves.ok) {'), setup.indexOf('const dir = leaves.workDir;'));
  assert.match(failed, /state: 'not-applied'/);
  assert.match(failed, /klog\(`memory cap: scope \$\{cap\.unit\} is not delegated or its leaves could not be built/);
  assert.match(failed, /return cliEnv\(null\);/);
  assert.match(failed, /tools are still wrapped/);
  assert.ok(setup.indexOf('if (!leaves.ok) {') < setup.indexOf('startMemoryWatch({'));
});

test('the cap, its read-back checks and the kill watch are on the WORK leaf (`dir`), never on the scope or the keeper leaf', () => {
  assert.match(setup, /const dir = leaves\.workDir;/);
  assert.match(setup, /parseCgroupLimit\(fs\.readFileSync\(path\.join\(dir, 'memory\.max'\), 'utf8'\)\)/);
  assert.match(setup, /memWatch = startMemoryWatch\(\{\n    cgroupDir: dir,/);
});

test('the CLI is NOT moved: it starts where the keeper is (leaf k); the work leaf reaches the TOOL wrapper through the CLI\'s environment, and the CLI is spawned as the client asked', () => {
  assert.match(setup, /const base: Record<string, string \| undefined> = \{ \.\.\.env, \.\.\.\(workLeaf \? \{ \[WORK_LEAF_ENV\]: workLeaf \} : \{\}\) \};/);
  assert.match(setup, /\n  return cliEnv\(dir\);$/, 'the success path hands the work leaf to the wrapper');
  assert.equal((setup.match(/cliEnv\(null\)/g) ?? []).length, 2, 'both failure branches (leaves not built, limit not applied) wrap the tools but name NO work leaf');
  assert.match(startChild, /child = spawn\(command, args, \{ cwd, env, stdio: \['pipe', 'pipe', 'pipe'\] \}\);/);
  assert.doesNotMatch(startChild, /cgroup\.procs|work leaf|workLeaf/, 'no rewrite of the CLI argv: a busy CLI inside the limited leaf lost the session 4/8 (Q9 addendum)');
  assert.doesNotMatch(keeper, /inWorkLeafArgv|workLeafDir/);
});

test('the wrapper is PROBED at runtime before `active` is claimed: a probe that does not land in the work leaf downgrades the state to unprotected and says so', () => {
  const probeAt = setup.indexOf('probeWithRetry(() => probeToolPlacement({');
  const stateAt = setup.indexOf('capInfo = { unit: cap.unit, state: decideCapState({ swapOk, wrapperOk, wrapperRuns, placed })');
  assert.ok(probeAt > 0 && stateAt > probeAt, 'the probe runs BEFORE the state is decided');
  const block = setup.slice(probeAt, stateAt);
  assert.match(block, /wrapper: cap\.wrapper as string,\n\s+workDir: dir,\n\s+cgroupRoot: CGROUP_ROOT,/);
  assert.match(block, /if \(!probe\.ok\) \{\n      placed = false;/);
  assert.match(block, /NOTHING is capped at the hard level/);
  assert.match(setup, /if \(wrapperOk && cap\.wrapper\) \{\n    const probe = probeWithRetry\(/, 'only when a wrapper is in play');
});

test('review m2 (#332 fu): a probe that still fails after ONE retry keeps the prefix when the wrapper RAN (tools keep adj 1000; the STATE says unprotected, loudly); a wrapper that cannot be EXECUTED is dropped as the prefix', () => {
  assert.match(setup, /const probe = probeWithRetry\(\(\) => probeToolPlacement\(\{/, 'one retry, through the tested helper');
  assert.match(setup, /run: runProbeSpawn,/, 'the real spawn + classification live in member-leaves.ts (unit-tested with real wrappers: 3 s tolerated, timeout = started, bad interpreter = cannot run)');
  assert.doesNotMatch(setup, /spawnSync\(/, 'no hand-rolled spawn in the keeper: a timeout must never be read as « cannot run » again');
  assert.match(setup, /\} else if \(probe\.timedOut\) \{\n        klog\(`memory cap: WARNING — the tool wrapper probe TIMED OUT after \$\{PROBE_TIMEOUT_MS\} ms: it STARTED/, 'OPS 7281: a timeout keeps the prefix, state unprotected, strong log');
  const block = setup.slice(setup.indexOf('let placed = true;'), setup.indexOf('placementTripwire = null;'));
  assert.match(block, /if \(!probe\.ok\) \{\n      placed = false;\n      if \(!probe\.ran\) \{\n        wrapperOk = false;\n        wrapperRuns = false;/, 'only a wrapper that never RAN is taken off (as the prefix it would fail every Bash call)');
  assert.equal((block.match(/wrapperOk = false/g) ?? []).length, 1, 'no other probe outcome touches wrapperOk');
  assert.match(setup, /state: decideCapState\(\{ swapOk, wrapperOk, wrapperRuns, placed \}\)/, 'the state comes from the tested pure function (unrunnable wrapper ⇒ not-applied)');
  assert.match(setup, /the prefix stays: they keep oom_score_adj \$\{OOM_ADJ_TOOLS\}/);
  assert.match(setup, /the shell prefix is NOT set \(it would fail every Bash call\)/);
  assert.match(setup, /klog\(`memory cap: WARNING — the tool wrapper could not be RUN \(\$\{probe\.attempts\} attempts: \$\{probe\.saw\}\)/, 'OPS 7259: the unrunnable wrapper is announced loudly (keeper log) — the app WARN comes from describeCapState(not-applied)');
});

test('review m2c (#332 fu): the placement TRIPWIRE is armed only for an `active` state, from the post-probe fault baseline, fed every stdout line of the CLI; tripping flips the state to unprotected and logs once', () => {
  assert.match(setup, /if \(capInfo\.state === 'active'\) \{\n    const readCpu = \(\): number \| null => readLeafCpuUsec\(/);
  assert.match(setup, /const base = readCpu\(\);\n    if \(base === null\) \{\n      klog\(`memory cap: the placement tripwire is NOT armed/, 'not arming is said, not silent');
  assert.match(setup, /readCounter: readCpu,/);
  assert.match(setup, /onGiveUp: \(n\) => klog\(/);
  assert.match(setup, /const readCpu = \(\): number \| null => readLeafCpuUsec\(\(\) => \{ try \{ return fs\.readFileSync\(path\.join\(dir, 'cpu\.stat'\), 'utf8'\); \}/, 'the counter file is cpu.stat (flushed on read), not memory.stat');
  assert.match(setup, /placementTripwire = createPlacementTripwire\(\{\n\s+baseline: base,/);
  assert.match(setup, /if \(capInfo\) capInfo = \{ \.\.\.capInfo, state: 'unprotected' \};/);
  assert.match(setup, /TRIPWIRE — \$\{n\} Bash tool results came back/);
  assert.match(setup, /after: intEnv\('ORCHESTRA_MEMCAP_TRIPWIRE_AFTER', 5\),/);
  assert.match(startChild, /try \{\n      placementTripwire\?\.onLine\(line\);\n    \} catch \{/, 'an observer never takes the keeper down');
  assert.ok(setup.indexOf('probeWithRetry(') < setup.indexOf('createPlacementTripwire('), 'armed after the probe');
});
