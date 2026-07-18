import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFoldPrompt,
  ensureLessonsImport,
  enumerateSelfTuneLogins,
  FOLD_RESULT_MARKER,
  isSelfTuneDue,
  lastSuccessAt,
  LESSONS_IMPORT,
  newestReport,
  parseFoldSummary,
  type SelfTuneRun,
} from './self-tune.ts';
import type { Account } from './accounts.ts';

const HOME = '/home/u';

// ---- isSelfTuneDue -----------------------------------------------------------

test('isSelfTuneDue: no prior success → due', () => {
  assert.equal(isSelfTuneDue(null, Date.now()), true);
  assert.equal(isSelfTuneDue(undefined, Date.now()), true);
  assert.equal(isSelfTuneDue(0, Date.now()), true);
});

test('isSelfTuneDue: success in the SAME calendar month → not due', () => {
  const success = new Date(2026, 6, 2, 9, 0).getTime();
  const now = new Date(2026, 6, 30, 23, 0).getTime();
  assert.equal(isSelfTuneDue(success, now), false);
});

test('isSelfTuneDue: success last month → due, even a day apart', () => {
  const success = new Date(2026, 5, 30).getTime();
  const now = new Date(2026, 6, 1).getTime();
  assert.equal(isSelfTuneDue(success, now), true);
});

test('isSelfTuneDue: same month number in a DIFFERENT year → due', () => {
  const success = new Date(2025, 6, 15).getTime();
  const now = new Date(2026, 6, 15).getTime();
  assert.equal(isSelfTuneDue(success, now), true);
});

// ---- lastSuccessAt -----------------------------------------------------------

function run(status: SelfTuneRun['status'], finishedAt?: number): SelfTuneRun {
  return { id: `r${finishedAt}`, trigger: 'auto', status, startedAt: 1, finishedAt, steps: [] };
}

test('lastSuccessAt: newest ok run wins; failed/running ignored', () => {
  assert.equal(lastSuccessAt([]), null);
  assert.equal(lastSuccessAt([run('failed', 100), run('running')]), null);
  assert.equal(lastSuccessAt([run('ok', 100), run('failed', 900), run('ok', 500)]), 500);
});

// ---- enumerateSelfTuneLogins -------------------------------------------------

function acct(id: string, configDir: string): Account {
  return { id, label: id, configDir };
}

test('enumerateSelfTuneLogins: default login always first, ~/.claude', () => {
  const logins = enumerateSelfTuneLogins([], HOME, {});
  assert.deepEqual(logins, [
    { id: 'default', label: 'default login', configDir: `${HOME}/.claude` },
  ]);
});

test('enumerateSelfTuneLogins: accounts expand ~ and ${VAR}', () => {
  const logins = enumerateSelfTuneLogins(
    [acct('mc', '~/.claude-mc'), acct('x', '${CFG}/claude')],
    HOME,
    { CFG: '/etc' },
  );
  assert.deepEqual(logins.map((l) => l.configDir), [
    `${HOME}/.claude`,
    `${HOME}/.claude-mc`,
    '/etc/claude',
  ]);
});

test('enumerateSelfTuneLogins: empty expansion and duplicates are skipped', () => {
  const logins = enumerateSelfTuneLogins(
    [
      acct('empty', '${UNSET_VAR}'),
      acct('dup-of-default', '~/.claude'),
      acct('mc', '~/.claude-mc'),
      acct('dup-of-mc', '~/.claude-mc'),
    ],
    HOME,
    {},
  );
  assert.deepEqual(logins.map((l) => l.id), ['default', 'mc']);
});

// ---- newestReport ------------------------------------------------------------

test('newestReport: picks the lexicographically newest timestamped report', () => {
  const names = [
    'report-2026-05-01-090000.html',
    'report-2026-07-17-114608.html',
    'report-2026-06-30-235959.html',
    'report.html',
    'facets',
    'self-tune.log',
  ];
  assert.equal(newestReport(names), 'report-2026-07-17-114608.html');
});

test('newestReport: falls back to bare report.html, else null', () => {
  assert.equal(newestReport(['report.html', 'facets']), 'report.html');
  assert.equal(newestReport(['facets', 'session-meta']), null);
  assert.equal(newestReport([]), null);
});

// ---- fold prompt + summary ---------------------------------------------------

test('buildFoldPrompt: lists every login report path, flags missing ones', () => {
  const prompt = buildFoldPrompt(
    [
      { loginId: 'default', label: 'default login', configDir: `${HOME}/.claude`, reportPath: `${HOME}/.claude/usage-data/report-2026-07-17-114608.html` },
      { loginId: 'mc', label: 'mc', configDir: `${HOME}/.claude-mc`, reportPath: null },
    ],
    HOME,
  );
  assert.match(prompt, /default login: \/home\/u\/\.claude\/usage-data\/report-2026-07-17-114608\.html/);
  assert.match(prompt, /mc: \(no report generated — skip this login\)/);
  // The core contract: cross-login dedupe, LESSONS.md's own rules, the log
  // append, and the machine-readable outcome marker.
  assert.match(prompt, /Dedupe across\s+the logins' reports first/);
  assert.match(prompt, /\/home\/u\/\.claude\/LESSONS\.md/);
  assert.match(prompt, /\/home\/u\/\.claude\/usage-data\/self-tune\.log/);
  assert.ok(prompt.includes(FOLD_RESULT_MARKER));
});

// ---- ensureLessonsImport -----------------------------------------------------

test('ensureLessonsImport: missing or blank CLAUDE.md → created with just the import', () => {
  assert.equal(ensureLessonsImport(null), `${LESSONS_IMPORT}\n`);
  assert.equal(ensureLessonsImport(''), `${LESSONS_IMPORT}\n`);
  assert.equal(ensureLessonsImport('  \n\n'), `${LESSONS_IMPORT}\n`);
});

test('ensureLessonsImport: import already present → no write needed', () => {
  assert.equal(ensureLessonsImport('@LESSONS.md\n'), null);
  assert.equal(ensureLessonsImport('@RTK.md\n@LESSONS.md\n\n## Rules\n'), null);
  // Token at end of file without a trailing newline still counts.
  assert.equal(ensureLessonsImport('some rules\n@LESSONS.md'), null);
});

test('ensureLessonsImport: content without the import → import appended', () => {
  assert.equal(ensureLessonsImport('## My rules\n- be nice\n'), '## My rules\n- be nice\n@LESSONS.md\n');
  // Missing trailing newline gets one before the import.
  assert.equal(ensureLessonsImport('## My rules'), '## My rules\n@LESSONS.md\n');
  // A near-miss token is not a match.
  assert.equal(ensureLessonsImport('see @LESSONS.mdx for details\n'), 'see @LESSONS.mdx for details\n@LESSONS.md\n');
});

test('parseFoldSummary: last marker line wins; absent → null', () => {
  const out = [
    'reading reports...',
    `${FOLD_RESULT_MARKER} 1 lesson added`,
    'wait, revising',
    `  ${FOLD_RESULT_MARKER} 2 lessons added  `,
  ].join('\n');
  assert.equal(parseFoldSummary(out), '2 lessons added');
  assert.equal(parseFoldSummary('no marker here'), null);
  assert.equal(parseFoldSummary(`${FOLD_RESULT_MARKER}   `), null);
});
