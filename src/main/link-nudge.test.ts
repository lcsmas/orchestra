import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLinearIssueCandidate } from '../shared/linear.ts';

// The PR/Linear link nudge (LINK_INSTRUCTION_SCRIPT in workspaces.ts) is pure
// bash with real branching: two cadences (SessionStart / UserPromptSubmit), a
// branch-mined issue-key suggestion that must agree with the TS parser, and a
// budget file that has to retire the per-prompt ask. None of that is checkable
// by reading it, and getting it wrong is expensive in both directions — a
// broken gate nags every single turn forever, a broken miner silently never
// fires at all.
//
// Unlike orchestra-hook.test.ts (which keeps a hand-copied excerpt), this
// EXTRACTS the real template literal from the source: the script's value here
// is precisely that it matches what ships, and a copy would drift. workspaces.ts
// itself can't be imported (it pulls in electron), so we slice the literal out
// textually and undo the TS escaping.
const SRC = fileURLToPath(new URL('./workspaces.ts', import.meta.url));

function extractScript(): string {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('const LINK_INSTRUCTION_SCRIPT = `');
  assert.notEqual(start, -1, 'LINK_INSTRUCTION_SCRIPT not found in workspaces.ts');
  const bodyStart = src.indexOf('`', start) + 1;
  const end = src.indexOf('\n`;', bodyStart);
  assert.notEqual(end, -1, 'unterminated LINK_INSTRUCTION_SCRIPT template');
  return (
    src
      .slice(bodyStart, end + 1)
      // Undo template-literal escaping: \$ \` \\ all stand for themselves.
      .replace(/\\([$`\\])/g, '$1')
      // The one real interpolation in the script.
      .replace(/\$\{LINK_PROMPT_NUDGE_BUDGET\}/g, String(BUDGET))
  );
}

/** Must match LINK_PROMPT_NUDGE_BUDGET in workspaces.ts. */
const BUDGET = 3;

interface Fixture {
  dir: string;
  run: (mode: 'session' | 'prompt') => string;
  budget: () => number;
  socketCalls: () => number;
}

function setup(opts: { branch: string; pr?: string; linear?: string }): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-link-'));
  const repo = path.join(dir, 'worktree');
  fs.mkdirSync(path.join(repo, '.orchestra'), { recursive: true });

  // A real git repo, because the script reads the branch LIVE from git (the
  // whole point: $ORCHESTRA_BRANCH is stale the moment a rename lands).
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  git('branch', '-M', opts.branch);

  // Fake `orchestra whoami`, printing the same padded "key  value" table the
  // CLI does, and recording each invocation so a test can assert the per-prompt
  // path did NOT open the socket.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(
    path.join(bin, 'orchestra'),
    `#!/usr/bin/env bash
echo x >> ${JSON.stringify(calls)}
cat <<EOF
id            ws-1
name          test
branch        ${opts.branch}
kind          worktree
orchestrator  no
parent        none (top-level)
repo          /tmp/repo
base          master
pr            ${opts.pr ?? '(none)'}
linear        ${opts.linear ?? '(none)'}
EOF
`,
    { mode: 0o755 },
  );

  const script = path.join(repo, '.orchestra', 'link-instruction.sh');
  fs.writeFileSync(script, extractScript(), { mode: 0o755 });

  return {
    dir,
    run: (mode) =>
      execFileSync('bash', mode === 'prompt' ? [script, 'prompt'] : [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          ORCHESTRA_WS_ID: 'ws-1',
          ORCHESTRA_WORKTREE: repo,
          ORCHESTRA_BRANCH: 'stale-env-branch',
          ORCHESTRA_KIND: 'worktree',
        },
      }),
    budget: () => {
      const f = path.join(repo, '.orchestra', '.link-nudges');
      return fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8').trim()) : 0;
    },
    socketCalls: () =>
      fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0,
  };
}

test('prompt mode suggests the branch-mined key and charges the budget once', () => {
  const fx = setup({ branch: 'verify-mc-4204-enviro-registered-parcels' });
  const out = fx.run('prompt');
  assert.match(out, /orchestra link --linear MC-4204/);
  // The branch comes from git, not the (deliberately stale) env var.
  assert.match(out, /verify-mc-4204-enviro-registered-parcels/);
  assert.doesNotMatch(out, /stale-env-branch/);
  assert.equal(fx.budget(), 1);
});

test('prompt mode retires after the budget is spent', () => {
  const fx = setup({ branch: 'nmc-261-diagnosis-pictures' });
  for (let i = 1; i <= BUDGET; i++) {
    assert.match(fx.run('prompt'), /NMC-261/, `nudge ${i} should print`);
    assert.equal(fx.budget(), i);
  }
  assert.equal(fx.run('prompt'), '', 'nudge past the budget must be silent');
  assert.equal(fx.budget(), BUDGET, 'a silent run must not charge the budget');
});

test('prompt mode retires itself once the Linear link exists', () => {
  // Silence alone is not enough: without spending the budget, a LINKED
  // workspace whose branch names a key would re-run `orchestra whoami` on every
  // prompt forever to rediscover the same answer.
  const fx = setup({ branch: 'mc-4204-thing', linear: 'MC-4204' });
  assert.equal(fx.run('prompt'), '');
  assert.equal(fx.budget(), BUDGET, 'a linked workspace must spend the budget outright');
  assert.equal(fx.run('prompt'), '');
  assert.equal(fx.socketCalls(), 1, 'the second prompt must not reach the socket at all');
});

test('prompt mode skips the socket entirely when the branch names no key', () => {
  const fx = setup({ branch: 'fix-checkout-typo' });
  assert.equal(fx.run('prompt'), '');
  assert.equal(fx.socketCalls(), 0, 'no whoami round-trip without a candidate');
  assert.equal(fx.budget(), 0, 'a rename can still introduce a key — do not retire');
});

test('a spent budget costs one stat: no git, no socket', () => {
  const fx = setup({ branch: 'mc-4204-thing' });
  for (let i = 0; i < BUDGET; i++) fx.run('prompt');
  const before = fx.socketCalls();
  assert.equal(fx.run('prompt'), '');
  assert.equal(fx.socketCalls(), before, 'the retired path must not query whoami');
});

test('prompt mode ignores a missing PR link (it only ever asks for Linear)', () => {
  const fx = setup({ branch: 'mc-4204-thing', linear: 'MC-4204' });
  assert.equal(fx.run('prompt'), '', 'PR is the SessionStart ask, not the per-turn one');
});

test('session mode names the candidate when the branch has one', () => {
  const fx = setup({ branch: 'mc-4204-enviro-parcels' });
  const out = fx.run('session');
  assert.match(out, /No PR linked/);
  assert.match(out, /orchestra link --linear MC-4204/);
  assert.equal(fx.budget(), 0, 'the SessionStart ask must not consume the prompt budget');
});

test('session mode falls back to the generic ask without a candidate', () => {
  const out = setup({ branch: 'fix-checkout-typo' }).run('session');
  assert.match(out, /orchestra link --linear <TEAM-123>/);
});

test('session mode asks only for the half that is missing, and stops when both are set', () => {
  const linearOnly = setup({ branch: 'fix-thing', linear: 'MC-1' }).run('session');
  assert.match(linearOnly, /No PR linked/);
  assert.doesNotMatch(linearOnly, /No Linear issue linked/);

  const both = setup({
    branch: 'fix-thing',
    linear: 'MC-1',
    pr: 'https://github.com/a/b/pull/1',
  }).run('session');
  assert.equal(both, '');
});

test('the bash miner agrees with parseLinearIssueCandidate', () => {
  // The script re-implements the TS parser in grep; a divergence means agents
  // get suggested keys Orchestra itself would reject (or none at all).
  const branches = [
    'verify-mc-4204-enviro-registered-parcels',
    'nmc-261-diagnosis-pictures',
    'feature/mc-12-x',
    'usage-poll-429-backoff',
    'v1-2-bump',
    'feature/cleanup',
    'MC-4204',
    'fix-checkout-typo',
  ];
  for (const branch of branches) {
    const expected = parseLinearIssueCandidate(branch);
    const out = setup({ branch }).run('prompt');
    if (expected) {
      assert.match(out, new RegExp(`--linear ${expected}\\b`), `${branch} -> ${expected}`);
    } else {
      assert.equal(out, '', `${branch} should yield no candidate`);
    }
  }
});
