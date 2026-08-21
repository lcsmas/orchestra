import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnergyEndpointer,
  fillPrompt,
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
