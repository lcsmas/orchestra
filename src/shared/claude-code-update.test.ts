import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeCodeUpdateCopy, decideClaudeCodeUpdate, parsePublishedVersion, publishedVersionUrl, updateChannel, updateFailureText } from './claude-code-update.ts';

test('mise à jour disponible: only when the published version is NEWER than the installed one (numbers, not strings)', () => {
  assert.deepEqual(decideClaudeCodeUpdate('2.1.310', '2.1.322'), { kind: 'available', installed: '2.1.310', published: '2.1.322' });
  assert.deepEqual(decideClaudeCodeUpdate('2.1.322', '2.1.322'), { kind: 'none' }, 'up to date');
  assert.deepEqual(decideClaudeCodeUpdate('2.1.322', '2.1.311'), { kind: 'none' }, 'installed ahead of the channel (latest installed, stable followed)');
  assert.deepEqual(decideClaudeCodeUpdate('2.1.99', '2.1.100').kind, 'available', '99 < 100 although "99" > "100" as text');
  assert.deepEqual(decideClaudeCodeUpdate('2.9.0', '2.10.0').kind, 'available');
});

test('mise à jour disponible: an unknown side never announces anything', () => {
  assert.deepEqual(decideClaudeCodeUpdate(null, '2.1.322'), { kind: 'none' }, 'no claude on PATH');
  assert.deepEqual(decideClaudeCodeUpdate('2.1.310', null), { kind: 'none' }, 'the network did not answer');
  assert.deepEqual(decideClaudeCodeUpdate('2.1.310', '<html>blocked</html>'), { kind: 'none' }, 'not a version');
});

test('échec: the words of `claude update` as it printed them (stderr, else all it wrote), bounded; a silent failure still says something', () => {
  // the real 2.1.310 output with the network cut (measured 2026-11-10)
  const stderr =
    'Error: Failed to install native update\nTelemetrySafeError: Failed to fetch version from https://downloads.claude.ai/claude-code-releases/latest after 3 attempt(s): connect ECONNREFUSED 127.0.0.1:9\nTry running "claude doctor" for diagnostics\n';
  assert.equal(updateFailureText({ code: 1, stdout: 'Current version: 2.1.310\nChecking for updates to latest version...\n', stderr }), stderr.trim());
  // (wording invented: what a package-manager install prints was not measured)
  assert.equal(updateFailureText({ code: 0, stdout: 'Current version: 2.1.310\nClaude is managed by Homebrew. Run: brew upgrade claude-code\n', stderr: '' }), 'Current version: 2.1.310\nClaude is managed by Homebrew. Run: brew upgrade claude-code', 'no stderr: all it wrote, not only its last line');
  assert.equal(updateFailureText({ code: 3, stdout: '', stderr: '  \n' }), 'claude update a échoué (code 3)');
  assert.equal(updateFailureText({ code: null, stdout: '', stderr: '' }), 'claude update n’a pas pu être lancé');
  assert.equal(updateFailureText({ code: 1, stdout: '', stderr: `${'x'.repeat(5000)}\nthe cause` }), `${'x'.repeat(590)}\nthe cause`, 'bounded to its END, where the cause is');
  assert.equal(updateFailureText({ code: 1, stdout: '', stderr: '\u001b[31mError:\u001b[0m boom' }), 'Error: boom', 'no terminal colour codes');
});

test('the notice in words: nothing when there is nothing to say; each state names its one gesture (the wording picked on the prototype)', () => {
  assert.equal(claudeCodeUpdateCopy({ kind: 'none' }), null);
  assert.deepEqual(claudeCodeUpdateCopy({ kind: 'available', installed: '2.1.310', published: '2.1.322' }), {
    tone: 'info',
    icon: '↑',
    strip: 'Claude Code 2.1.322 disponible',
    title: 'Mise à jour de Claude Code disponible',
    installed: '2.1.310',
    published: '2.1.322',
    note: 'Les sessions en cours ne sont pas redémarrées : elles passent à 2.1.322 à leur prochain démarrage.',
    error: '',
    action: 'update',
    actionLabel: 'Mettre à jour',
    busy: false,
  });
  const running = claudeCodeUpdateCopy({ kind: 'running', installed: '2.1.310', published: '2.1.322' })!;
  assert.deepEqual([running.icon, running.strip, running.action, running.actionLabel, running.busy], ['↻', 'Mise à jour de Claude Code…', 'update', 'Mise à jour…', true]);
  const done = claudeCodeUpdateCopy({ kind: 'installed', from: '2.1.310', version: '2.1.322' })!;
  assert.deepEqual([done.tone, done.icon, done.strip, done.installed, done.published, done.action, done.actionLabel], ['ok', '✓', 'Claude Code 2.1.322 installé', '2.1.322', '', 'ack', 'OK']);
  assert.match(done.note, /celles en cours gardent 2\.1\.310 jusqu’à leur prochain démarrage/);
  const failed = claudeCodeUpdateCopy({ kind: 'failed', installed: '2.1.310', published: '2.1.322', error: 'Error: boom' })!;
  assert.deepEqual([failed.tone, failed.icon, failed.strip, failed.error, failed.action, failed.actionLabel], ['error', '!', 'Mise à jour impossible', 'Error: boom', 'update', 'Réessayer']);
  // CONTEXT.md: « nouvelle version » is ambiguous between Orchestra's and Claude Code's — never in this notice
  for (const s of [{ kind: 'available', installed: '1.0.0', published: '1.0.1' }, { kind: 'running', installed: '1.0.0', published: '1.0.1' }, { kind: 'installed', from: '1.0.0', version: '1.0.1' }] as const) assert.doesNotMatch(JSON.stringify(claudeCodeUpdateCopy(s)), /nouvelle version/i);
});

test('published version: the channel `claude update` itself follows (settings.json), read as a bare version or not at all', () => {
  assert.equal(updateChannel(null), 'latest', 'no settings file');
  assert.equal(updateChannel('{"autoUpdatesChannel":"stable"}'), 'stable');
  assert.equal(updateChannel('{"autoUpdatesChannel":"latest","env":{}}'), 'latest');
  assert.equal(updateChannel('{"autoUpdatesChannel":"../../evil"}'), 'latest', 'only the two known channels reach the URL');
  assert.equal(updateChannel('{not json'), 'latest');
  assert.equal(publishedVersionUrl('https://downloads.claude.ai/claude-code-releases', 'stable'), 'https://downloads.claude.ai/claude-code-releases/stable');
  assert.equal(publishedVersionUrl('http://127.0.0.1:4010/rel/', 'latest'), 'http://127.0.0.1:4010/rel/latest');
  assert.equal(parsePublishedVersion('2.1.322'), '2.1.322');
  assert.equal(parsePublishedVersion('2.1.322\n'), '2.1.322');
  assert.equal(parsePublishedVersion('<!doctype html><title>403</title>'), null, 'an error page is not a version');
  assert.equal(parsePublishedVersion(''), null);
});
