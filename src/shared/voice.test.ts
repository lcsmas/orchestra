import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnergyEndpointer,
  fillPrompt,
  ghostForEvent,
  parseRouterReply,
  ROUTER_PROMPT,
} from './voice.ts';

// ---- parseRouterReply -------------------------------------------------------

test('parseRouterReply: clean append JSON', () => {
  const r = parseRouterReply('{"op":"append","text":"Bonjour."}', 'fb');
  assert.deepEqual(r, { op: 'append', text: 'Bonjour.' });
});

test('parseRouterReply: replace_last with markdown fences', () => {
  const r = parseRouterReply('```json\n{"op":"replace_last","text":"Fixed."}\n```', 'fb');
  assert.deepEqual(r, { op: 'replace_last', text: 'Fixed.' });
});

test('parseRouterReply: garbage degrades to append(fallback)', () => {
  assert.deepEqual(parseRouterReply('not json at all', 'the utterance'), {
    op: 'append',
    text: 'the utterance',
  });
});

test('parseRouterReply: wrong op degrades to append(fallback)', () => {
  assert.deepEqual(parseRouterReply('{"op":"delete_all","text":"x"}', 'fb'), {
    op: 'append',
    text: 'fb',
  });
});

// ---- fillPrompt --------------------------------------------------------------

test('fillPrompt substitutes placeholders and leaves JSON braces intact', () => {
  const out = fillPrompt(ROUTER_PROMPT, { prev: 'AAA', new: 'BBB', vocab: 'PR, repo' });
  assert.ok(out.includes('PREVIOUS: AAA'));
  assert.ok(out.includes('NEW: BBB'));
  assert.ok(out.includes('PR, repo'));
  // The router's example JSON braces must survive untouched.
  assert.ok(out.includes('{"op":"replace_last","text":'));
  assert.ok(!out.includes('{prev}') && !out.includes('{new}') && !out.includes('{vocab}'));
});

// ---- EnergyEndpointer ---------------------------------------------------------

const SR = 16000;
const FRAME_MS = 100;
const N = (SR * FRAME_MS) / 1000;

function silence(noise = 50): Int16Array {
  const f = new Int16Array(N);
  for (let i = 0; i < N; i++) f[i] = Math.round(((i * 2654435761) % 1000) / 1000 - 0.5) * noise;
  return f;
}
function speech(amp = 8000): Int16Array {
  const f = new Int16Array(N);
  for (let i = 0; i < N; i++) f[i] = Math.round(Math.sin(i / 10) * amp);
  return f;
}

test('endpointer: fires after 800ms silence following speech', () => {
  const ep = new EnergyEndpointer();
  for (let i = 0; i < 5; i++) assert.equal(ep.feed(speech()), false); // 500ms speech
  assert.ok(ep.hasSpeech);
  let fired = 0;
  for (let i = 0; i < 8; i++) if (ep.feed(silence())) fired++; // 800ms silence
  assert.equal(fired, 1);
  assert.ok(!ep.hasSpeech, 'resets after firing');
});

test('endpointer: never fires during continuous speech', () => {
  const ep = new EnergyEndpointer();
  for (let i = 0; i < 100; i++) assert.equal(ep.feed(speech()), false); // 10s
});

test('endpointer: never fires on pure silence (no speech yet)', () => {
  const ep = new EnergyEndpointer();
  for (let i = 0; i < 50; i++) assert.equal(ep.feed(silence()), false);
});

test('endpointer: a sub-300ms blip does not arm an endpoint', () => {
  const ep = new EnergyEndpointer();
  ep.feed(speech()); ep.feed(speech()); // 200ms < minSpeechMs
  let fired = 0;
  for (let i = 0; i < 20; i++) if (ep.feed(silence())) fired++;
  assert.equal(fired, 0);
});

test('endpointer: adapts to a noisy floor instead of reading it as speech', () => {
  // Constant fan noise at amplitude ~600 RMS: above the abs floor, but the EMA
  // should absorb it within a few seconds so it never counts as speech.
  const ep = new EnergyEndpointer();
  const fan = new Int16Array(N).fill(600);
  let fired = 0;
  for (let i = 0; i < 100; i++) if (ep.feed(fan)) fired++; // 10s of fan
  assert.equal(fired, 0);
});

// ---- ghostForEvent -----------------------------------------------------------
// Regression cover for the stranded-ghost bug: grey partial text left painted in
// the composer while the mic is OFF. Every dead-end path below emitted no
// terminator before the fix, so the last `partial` stayed on screen forever.

test('ghost: an idle mic never paints a ghost, whatever the engine says', () => {
  // A partial decode in flight when the user releases the mic resolves AFTER
  // micState went idle. This is the exact race the user reported.
  assert.equal(ghostForEvent({ type: 'partial', text: 'late decode' }, 'idle'), null);
  assert.equal(ghostForEvent({ type: 'instruction', text: 'x' }, 'idle'), null);
  assert.equal(ghostForEvent({ type: 'state', text: 'listening' }, 'idle'), null);
});

test('ghost: a live partial paints while dictating', () => {
  assert.equal(ghostForEvent({ type: 'partial', text: 'bonjour' }, 'dictate'), 'bonjour');
});

test('ghost: an empty partial clears (engine heard nothing this utterance)', () => {
  // main emits `partial:''` on the two dead ends that skip finalize(): a
  // sub-0.4s tail, and an empty transcription.
  assert.equal(ghostForEvent({ type: 'partial', text: '' }, 'dictate'), null);
  assert.equal(ghostForEvent({ type: 'partial' }, 'dictate'), null);
});

test('ghost: state=stopped is a terminator, other states are no-ops', () => {
  assert.equal(ghostForEvent({ type: 'state', text: 'stopped' }, 'dictate'), null);
  assert.equal(ghostForEvent({ type: 'state', text: 'listening' }, 'dictate'), undefined);
});

test('ghost: every terminal event clears it', () => {
  for (const type of ['clean', 'revision', 'error'] as const) {
    assert.equal(ghostForEvent({ type, text: 'whatever' }, 'dictate'), null, type);
  }
});

test('ghost: instruction shows what the STT heard, quoted', () => {
  assert.equal(
    ghostForEvent({ type: 'instruction', text: 'replace country' }, 'edit'),
    '\u00ab replace country \u00bb',
  );
});

test('ghost: non-ghost events leave it untouched mid-utterance', () => {
  // `endpoint`/`final` arrive between the last partial and the clean; clearing
  // there would flicker the ghost off and back on.
  assert.equal(ghostForEvent({ type: 'endpoint' }, 'dictate'), undefined);
  assert.equal(ghostForEvent({ type: 'final', text: 'raw' }, 'dictate'), undefined);
});
