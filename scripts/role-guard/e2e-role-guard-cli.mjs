// #468 — the role guard against the REAL `claude -p` CLI + the LOCAL FAKE Anthropic API (zero tokens): does the deny REACH the CLI?
// Scratch HOME / CLAUDE_CONFIG_DIR only (assertScratch refuses a live dir); the hook is the INSTALLED command string.
//   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/role-guard/e2e-role-guard-cli.mjs
// Every arm prints one line; the last line is `ROLE-GUARD-CLI: PASS|FAIL`. Exit 1 on any FAIL.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { startFakeApi } = await import(`${REPO}/scripts/session-budget/fake-anthropic-api.mjs`);
const { assertScratch, liveDirs } = await import(`${REPO}/scripts/session-budget/scratch-guard.mjs`);
const { HOOK_ROLE_GUARD_CMD, ROLE_GUARD_MATCHER, ROLE_GUARD_SCRIPT } = await import(`${REPO}/src/shared/role-guard.ts`);

const live = liveDirs();
// NOT under /tmp, /var/tmp or $TMPDIR: those count as scratch for the guard, so a tmp root would make every deny arm vacuous.
// /dev/shm (tmpfs, never the human's /run/user — see rig-runtime-world.test.ts) by default; RG_ROOT_BASE overrides.
const base = [process.env.RG_ROOT_BASE, '/dev/shm'].find((d) => d && fs.existsSync(d));
if (!base) { console.error('role-guard-cli: no non-/tmp scratch base (set RG_ROOT_BASE)'); process.exit(2); }
const root = fs.mkdtempSync(path.join(base, 'role-guard-cli-'));
assertScratch('root', root, root, live);
const claudeBin = spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
if (!claudeBin) { console.error('role-guard-cli: no `claude` on PATH'); process.exit(2); }

const results = [];
let armsStarted = 0; // pass needs EVERY started arm recorded and green (no hardcoded count to drift)
function record(name, ok, detail) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); }

/** One arm = one fresh worktree + one `claude -p` run whose model script is `toolUse`. */
async function arm({ name, role, hookCmd = HOOK_ROLE_GUARD_CMD, toolUse, expect, stream = false, shim = false }) {
  armsStarted += 1;
  const home = path.join(root, `home-${name}`);
  const cfg = path.join(home, '.claude');
  const wt = path.join(home, 'wt');
  for (const [label, p] of [['HOME', home], ['CLAUDE_CONFIG_DIR', cfg], ['worktree', wt]]) assertScratch(label, p, root, live);
  fs.mkdirSync(path.join(wt, '.orchestra'), { recursive: true });
  fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  spawnSync('git', ['init', '-q', wt]);
  spawnSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'base']);
  fs.writeFileSync(path.join(wt, '.orchestra', 'role-guard.sh'), ROLE_GUARD_SCRIPT, { mode: 0o755 });
  if (role) fs.writeFileSync(path.join(wt, '.orchestra', 'role'), `${role}\n`);
  fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: ROLE_GUARD_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }] } }));
  // `shim`: a fake `orchestra` first on PATH that only records it ran (`ran.txt` in the worktree) — the real one would call gh.
  const binDir = path.join(home, 'bin');
  if (shim) {
    assertScratch('shim bin', binDir, root, live);
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'orchestra'), `#!/bin/sh\necho "shim-ran: $*" | tee "${path.join(wt, 'ran.txt')}"\n`, { mode: 0o755 });
  }
  const tu = typeof toolUse === 'function' ? toolUse(wt) : toolUse;
  const api = await startFakeApi({
    keepMessages: true,
    reply: (rec) => {
      const last = rec.messages?.[rec.messages.length - 1];
      const hasResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
      if (rec.tools > 0 && !hasResult && !rec.__called) { rec.__called = true; return { toolUse: tu }; }
      return { text: 'done' };
    },
  });
  const env = {
    PATH: shim ? `${binDir}:${process.env.PATH}` : process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: cfg, TERM: 'dumb',
    ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-role-guard', HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    ORCHESTRA_WORKTREE: wt, ORCHESTRA_WS_ID: `rg-${name}`, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const out = await new Promise((resolve) => {
    // `stream`: the SDK's own transport (stream-json both ways) — the only mode where AskUserQuestion is enabled (plain -p disables it).
    const args = stream
      ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']
      : ['-p', 'go', '--dangerously-skip-permissions', '--output-format', 'text'];
    const child = spawn(claudeBin, args, { cwd: wt, env, stdio: [stream ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (stream) { child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n`); child.stdin.end(); }
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, buf }); });
  });
  // The tool_result the model was handed back (what the CLI made of the hook's verdict).
  const results2 = api.requests.filter((r) => r.type === 'model').flatMap((r) => (r.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))).filter((c) => c.type === 'tool_result');
  const resultText = results2.map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content))).join('\n');
  const commits = spawnSync('git', ['-C', wt, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (process.env.RG_DEBUG) console.log(JSON.stringify({ cli: out, reqs: api.requests.map((r) => ({ t: r.type, p: r.path, tools: r.tools, model: r.model, nm: Array.isArray(r.messages) ? r.messages.length : r.messages })) }, null, 1).slice(0, 3000));
  await api.stop();
  const ctx = { wt, resultText, commits: Number(commits), isError: results2.some((c) => c.is_error === true), cliOut: out.buf, cliCode: out.code, sawToolUse: api.requests.some((r) => r.type === 'model') };
  const verdict = expect(ctx);
  record(name, verdict.ok, `${verdict.why} | tool_result=${JSON.stringify(resultText.slice(0, 110))}`);
}

const writeCode = (wt) => ({ name: 'Write', input: { file_path: path.join(wt, 'code.ts'), content: 'export {}\n' } });
const exists = (wt, f) => fs.existsSync(path.join(wt, f));

await arm({ name: 'coordinator-Write-denied', role: 'coordinator', toolUse: writeCode,
  expect: (c) => ({ ok: !exists(c.wt, 'code.ts') && /BLOCKED \(role: coordinator\)/.test(c.resultText) && c.isError, why: 'file NOT created, CLI relayed the BLOCKED message as an error tool_result' }) });
await arm({ name: 'verifier-git-commit-denied', role: 'verifier', toolUse: { name: 'Bash', input: { command: 'git commit --allow-empty -m role-guard-probe', description: 'probe' } },
  expect: (c) => ({ ok: c.commits === 1 && /BLOCKED \(role: verifier\)/.test(c.resultText), why: 'no new commit (1), BLOCKED relayed' }) });
await arm({ name: 'implementer-AskUserQuestion-denied', role: 'implementer', stream: true, toolUse: { name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] } },
  expect: (c) => ({ ok: /AskUserQuestion is not available/.test(c.resultText), why: 'the question never reached a human; the deny text is the tool_result' }) });
await arm({ name: 'coordinator-chain-denied', role: 'coordinator', toolUse: { name: 'Bash', input: { command: 'orchestra verify-landed impl-x && orchestra delete abc --yes', description: 'probe' } },
  expect: (c) => ({ ok: /chained with a destructive act/.test(c.resultText), why: 'check+destroy chain refused before `orchestra` ran' }) });
// m1 follow-up: a Bash redirect into the worktree is refused for a read-only role (heuristic, but it must reach the CLI).
await arm({ name: 'reviewer-redirect-write-denied', role: 'reviewer', toolUse: { name: 'Bash', input: { command: 'echo x > leaked.txt', description: 'probe' } },
  expect: (c) => ({ ok: !exists(c.wt, 'leaked.txt') && /shell write to 'leaked\.txt'/.test(c.resultText), why: 'redirect target refused, file NOT created' }) });
// delta2 review: a write INSIDE a quote wrapper (bash -c "… > f") is still refused and reaches the CLI.
await arm({ name: 'reviewer-bash-c-write-denied', role: 'reviewer', toolUse: { name: 'Bash', input: { command: 'bash -c "echo x > leaked2.txt"', description: 'probe' } },
  expect: (c) => ({ ok: !exists(c.wt, 'leaked2.txt') && /shell write to 'leaked2\.txt'/.test(c.resultText), why: 'bash -c redirect refused, file NOT created' }) });
// follow-up review: `-c` of a NON-shell command is data — `grep -c ">"` must reach the shell (not read as a redirect).
await arm({ name: 'reviewer-grep-c-gt-allowed', role: 'reviewer', toolUse: { name: 'Bash', input: { command: 'grep -c ">" .git/HEAD; echo grep-c-ran', description: 'probe' } },
  expect: (c) => ({ ok: /grep-c-ran/.test(c.resultText) && !/BLOCKED/.test(c.resultText), why: 'grep -c ">" ran, no BLOCKED' }) });
// delta review: a quoted arrow is NOT a redirect — the ledger post itself (`--body "a -> b"`) must reach the shell.
await arm({ name: 'reviewer-quoted-arrow-allowed', role: 'reviewer', toolUse: { name: 'Bash', input: { command: 'echo "m1 -> fixed, count > 3"', description: 'probe' } },
  expect: (c) => ({ ok: /m1 -> fixed/.test(c.resultText) && !/BLOCKED/.test(c.resultText), why: 'echo with -> and > inside quotes ran, no BLOCKED' }) });
// #473: `orchestra fanout deliver` (merges a PR via gh internally) is denied to a non-coordinator, REACHES the CLI, and the CLI never runs it.
const DELIVER = 'orchestra fanout deliver --branch impl-x --into master --ticket 473';
const deliverArm = (name, role, ok, why) => arm({ name, role, shim: true, toolUse: { name: 'Bash', input: { command: DELIVER, description: 'probe' } }, expect: (c) => ({ ok: ok(c), why }) });
await deliverArm('implementer-fanout-deliver-denied', 'implementer', (c) => !exists(c.wt, 'ran.txt') && /BLOCKED \(role: implementer\).*coordinator/.test(c.resultText), 'orchestra shim NOT run, BLOCKED + coordinator pointer relayed');
await deliverArm('verifier-fanout-deliver-denied', 'verifier', (c) => !exists(c.wt, 'ran.txt') && /BLOCKED \(role: verifier\)/.test(c.resultText), 'orchestra shim NOT run, BLOCKED relayed');
await deliverArm('coordinator-fanout-deliver-allowed', 'coordinator', (c) => exists(c.wt, 'ran.txt') && !/BLOCKED/.test(c.resultText), 'known-good: the shim RAN for the coordinator');
await deliverArm('MUSTFAIL-no-sentinel-fanout-deliver-runs', null, (c) => exists(c.wt, 'ran.txt') && !/BLOCKED/.test(c.resultText), 'inert guard: the same deliver RAN (the deny arms above can fail)');
// known-good control: an ALLOWED call under the same hook still runs (its output comes back as the tool_result).
await arm({ name: 'verifier-allowed-Bash-runs', role: 'verifier', toolUse: { name: 'Bash', input: { command: 'git log --oneline -1', description: 'probe' } },
  expect: (c) => ({ ok: /\bbase\b/.test(c.resultText) && !/BLOCKED/.test(c.resultText), why: 'allowed command ran: git log printed the base commit, no BLOCKED' }) });
// known-inert control: no sentinel ⇒ the same Write that was denied goes through.
await arm({ name: 'no-sentinel-inert', role: null, toolUse: writeCode,
  expect: (c) => ({ ok: exists(c.wt, 'code.ts') && !/BLOCKED/.test(c.resultText), why: 'file created — the guard is inert without .orchestra/role' }) });
// MUST-FAIL arm: the `|| true` form swallows exit 2 — the SAME denied Write now lands (proves the other arms can fail).
await arm({ name: 'MUSTFAIL-or-true-lets-it-through', role: 'coordinator', hookCmd: `${HOOK_ROLE_GUARD_CMD} || true`, toolUse: writeCode,
  expect: (c) => ({ ok: exists(c.wt, 'code.ts'), why: 'with `|| true` the denied Write was CREATED (the broken form passes the deny)' }) });

fs.rmSync(root, { recursive: true, force: true });
const pass = armsStarted > 0 && results.length === armsStarted && results.every(Boolean);
console.log(`ROLE-GUARD-CLI: ${pass ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(pass ? 0 : 1);
