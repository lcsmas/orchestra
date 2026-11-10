import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BLOC_HTML_INSTRUCTION, BLOC_HTML_INSTRUCTION_MAX_CHARS, BLOC_HTML_MAX_SOURCE_KIB, BLOC_HTML_THEME_VARS, blocHtmlInstructionScript } from './bloc-html-instruction.ts';
import { BLOC_HTML_POLICY } from './bloc-html-document.ts';
import { BLOC_HTML_MAX_SOURCE_BYTES } from './reply-segments.ts';
import { BLOC_HTML_ENV, normalizeBlocHtmlEnabled, readBlocHtmlEnabled } from './bloc-html-setting.ts';

test('the instruction names the fence label, the title attribute and a closing fence', () => {
  assert.match(BLOC_HTML_INSTRUCTION, /^```html-render title="[^"]+"$/m);
  assert.equal(BLOC_HTML_INSTRUCTION.split('\n').filter((l) => l === '```').length, 1);
  assert.ok(BLOC_HTML_INSTRUCTION.includes('A quote in the title is written \\".'), 'title escape (#415: \\" accepted)');
});

test('the instruction lists every theme custom property', () => {
  for (const v of BLOC_HTML_THEME_VARS) assert.ok(BLOC_HTML_INSTRUCTION.includes(`var(${v})`), v);
  assert.equal(BLOC_HTML_THEME_VARS.length, 8);
});

test('the instruction states the limits: https network, offline forms, size cap, no state kept, height = content', () => {
  assert.match(BLOC_HTML_INSTRUCTION, /Network: https: only/);
  assert.match(BLOC_HTML_INSTRUCTION, /needs the network to render/);
  assert.match(BLOC_HTML_INSTRUCTION, /plain http: is refused/);
  assert.match(BLOC_HTML_INSTRUCTION, /data: and blob: work offline/);
  assert.match(BLOC_HTML_INSTRUCTION, /No state is kept/);
  assert.match(BLOC_HTML_INSTRUCTION, /cannot talk to the conversation/);
  assert.match(BLOC_HTML_INSTRUCTION, /no 100vh/);
  assert.ok(!/self-contained|no network at all/i.test(BLOC_HTML_INSTRUCTION), 'the retired no-network wording is gone (D5)');
});

test('the size cap in the text is DERIVED from the reader constant (a retune moves the text, never the other way)', () => {
  assert.equal(BLOC_HTML_MAX_SOURCE_KIB, BLOC_HTML_MAX_SOURCE_BYTES / 1024);
  assert.ok(BLOC_HTML_INSTRUCTION.includes(`Past ${BLOC_HTML_MAX_SOURCE_BYTES / 1024} KiB of source`));
});

/** the sources of one CSP directive, from the shipped policy string */
const directive = (name: string): string[] => (BLOC_HTML_POLICY.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) ?? []).slice(1);
/** the source kinds the text says may load over https (its sentence between "https: only." and "may load from https URLs"), and the directive each kind maps to */
const KIND_DIRECTIVE: Record<string, string> = { scripts: 'script-src', styles: 'style-src', fonts: 'font-src', images: 'img-src', fetch: 'connect-src', 'wss:': 'connect-src' };
const claimed = (): string[] => {
  const m = /Network: https: only\. (.+?) may load from https URLs/.exec(BLOC_HTML_INSTRUCTION);
  assert.ok(m, 'the source-kind sentence exists');
  return m[1].replace(/\([^)]*\)/g, '').split(/,\s*|\s+and\s+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
};

test('network claims ↔ the SHIPPED policy, both ways: every claimed kind is allowed over https:, every https: source the policy opens is claimed', () => {
  const kinds = claimed();
  for (const k of kinds) assert.ok(KIND_DIRECTIVE[k], `unknown source kind claimed in the text: "${k}"`);
  for (const k of kinds) assert.ok(directive(KIND_DIRECTIVE[k]).includes('https:'), `text claims ${k}: ${KIND_DIRECTIVE[k]} must allow https:`);
  assert.ok(directive('connect-src').includes('wss:') && kinds.includes('wss:') && !/(^|[^w])ws:/.test(BLOC_HTML_INSTRUCTION), 'wss: (never ws:) is claimed and allowed');
  const policyDirs = BLOC_HTML_POLICY.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d.includes('https:')).map((d) => d[0]).sort();
  const claimedDirs = [...new Set(kinds.map((k) => KIND_DIRECTIVE[k]))].sort();
  assert.deepEqual(policyDirs, claimedDirs, 'a directive that opens https: is claimed in the text, and none is claimed that does not');
  // offline forms and the inline claim
  assert.ok(directive('script-src').includes("'unsafe-inline'") && directive('style-src').includes("'unsafe-inline'") && /Inline <style>\/<script>/.test(BLOC_HTML_INSTRUCTION), 'inline script/style: allowed AND said');
  for (const d of ['img-src', 'font-src', 'connect-src']) assert.ok(directive(d).includes('data:'), `${d} allows data:`);
  assert.ok(directive('script-src').includes('blob:'), 'blob: said to work');
  assert.ok(!directive('script-src').includes('data:') && !directive('style-src').includes('data:'), 'data: is not a script/style source (the Limits clause says so)');
});

test('the refusals the text states hold in the SHIPPED policy, and the policy opens nothing the text does not allow', () => {
  assert.ok(/Limits: No eval\/new Function, no <iframe>\/<video>\/<audio>\/forms; data: is for images, fonts and fetch only\./.test(BLOC_HTML_INSTRUCTION), 'the limits clause is said');
  assert.ok(!/unsafe-eval|wasm-unsafe-eval/.test(BLOC_HTML_POLICY), 'no eval');
  for (const d of ['frame-src', 'child-src', 'media-src', 'object-src', 'worker-src', 'manifest-src']) assert.ok(!BLOC_HTML_POLICY.includes(d), `${d} is never opened (default-src 'none' stays the rule)`);
  assert.ok(BLOC_HTML_POLICY.startsWith("default-src 'none';") && /form-action 'none'/.test(BLOC_HTML_POLICY) && /base-uri 'none'/.test(BLOC_HTML_POLICY), 'default deny + forms + base refused');
  assert.ok(!/(^|[\s;])\*(\s|;|$)|(^|[\s;])(http|ws):/.test(BLOC_HTML_POLICY), 'no wildcard, no plain http:/ws:');
  // the text never offers what the policy refuses: iframe/video/audio only appear inside the refusal clause; http: only as "plain http: is refused"
  const without = BLOC_HTML_INSTRUCTION.replace(/no <iframe>\/<video>\/<audio>\/forms/, '');
  assert.ok(!/iframe|video|audio/i.test(without), 'iframe/video/audio only in the refusal');
  assert.equal((BLOC_HTML_INSTRUCTION.match(/(^|[^s])http:/g) ?? []).length, 1);
  assert.ok(BLOC_HTML_INSTRUCTION.includes('plain http: is refused'));
});

test('the instruction says when to use it rather than prose, and that a plain html fence stays a sample', () => {
  assert.match(BLOC_HTML_INSTRUCTION, /only where it beats prose/);
  assert.match(BLOC_HTML_INSTRUCTION, /Ordinary answers stay markdown/);
  assert.match(BLOC_HTML_INSTRUCTION, /plain ```html fence stays a code sample/);
});

test('the instruction stays short (re-billed at every session start)', () => {
  assert.ok(BLOC_HTML_INSTRUCTION.length <= BLOC_HTML_INSTRUCTION_MAX_CHARS, `${BLOC_HTML_INSTRUCTION.length} chars`);
  assert.ok(BLOC_HTML_INSTRUCTION.split('\n').length <= 10);
});

function run(env: Record<string, string>): { out: string; rc: number | null } {
  const r = spawnSync('bash', ['-c', blocHtmlInstructionScript()], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  return { out: r.stdout, rc: r.status };
}

test('the hook script prints the instruction byte for byte when the CLI carries the flag', () => {
  const r = run({ [BLOC_HTML_ENV]: '1' });
  assert.equal(r.rc, 0);
  assert.equal(r.out, BLOC_HTML_INSTRUCTION + '\n');
});

test('the hook script is silent when the flag is absent, 0 or empty (must-FAIL arm of the switch)', () => {
  for (const env of [{}, { [BLOC_HTML_ENV]: '0' }, { [BLOC_HTML_ENV]: '' }, { [BLOC_HTML_ENV]: 'true' }]) {
    const r = run(env);
    assert.equal(r.rc, 0);
    assert.equal(r.out, '', JSON.stringify(env));
  }
});

test('the instruction cannot end the script early: no line equals the heredoc terminator', () => {
  assert.ok(!BLOC_HTML_INSTRUCTION.split('\n').includes('ORCHESTRA_BLOC_HTML_EOF'));
});

test('the switch is ON by default: absent, null and malformed read ON; only a literal false is OFF', () => {
  for (const v of [undefined, null, true, 'false', 0, {}, 'off']) assert.equal(normalizeBlocHtmlEnabled(v), true, String(v));
  assert.equal(normalizeBlocHtmlEnabled(false), false);
});

test('a reader that throws reads OFF; a reader that answers is normalized (absent ⇒ ON)', () => {
  assert.equal(readBlocHtmlEnabled(() => { throw new Error('store down'); }), false);
  assert.equal(readBlocHtmlEnabled(() => undefined), true);
  assert.equal(readBlocHtmlEnabled(() => false), false);
});

test('the frozen names the model is told, pinned as literals: the fence label and the eight frame variables', () => {
  assert.deepEqual(BLOC_HTML_THEME_VARS, ['--bloc-fg', '--bloc-muted', '--bloc-surface', '--bloc-border', '--bloc-accent', '--bloc-ok', '--bloc-warn', '--bloc-err']);
  assert.ok(BLOC_HTML_INSTRUCTION.includes('```html-render title="'));
});
