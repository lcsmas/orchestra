import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_DICTIONARY_KEY,
  parseVoiceDictionary,
  readVoiceDictionary,
  readVoiceDictionaryRaw,
  writeVoiceDictionary,
} from './voice-dictionary.ts';

/** Minimal injectable localStorage double. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

test('parse splits on commas, newlines and semicolons', () => {
  assert.deepEqual(parseVoiceDictionary('Vecna, Hasura\nSlimPay; Coppio'), [
    'Vecna',
    'Hasura',
    'SlimPay',
    'Coppio',
  ]);
});

test('parse trims blanks and collapses repeated separators', () => {
  assert.deepEqual(parseVoiceDictionary('  Vecna ,,\n\n  Hasura  ,'), ['Vecna', 'Hasura']);
});

test('parse drops case-insensitive duplicates but keeps the first spelling', () => {
  assert.deepEqual(parseVoiceDictionary('SlimPay, slimpay, SLIMPAY'), ['SlimPay']);
});

test('parse preserves the exact casing of each term', () => {
  // The dictionary exists to carry the RIGHT spelling, so casing is load-bearing.
  assert.deepEqual(parseVoiceDictionary('PR, ydu_nxt, api-v2'), ['PR', 'ydu_nxt', 'api-v2']);
});

test('parse returns an empty list for blank input', () => {
  assert.deepEqual(parseVoiceDictionary(''), []);
  assert.deepEqual(parseVoiceDictionary('   \n , ; '), []);
});

test('read returns a comma-joined list ready to append to DEFAULT_VOCAB', () => {
  const s = fakeStorage({ [VOICE_DICTIONARY_KEY]: 'Vecna\nHasura\nSlimPay' });
  assert.equal(readVoiceDictionary(s), 'Vecna, Hasura, SlimPay');
});

test('read returns empty string when unset, so callers can test truthiness', () => {
  assert.equal(readVoiceDictionary(fakeStorage()), '');
});

test('read returns empty string when the stored text holds no terms', () => {
  // Guards the concat site: a whitespace-only dictionary must not append ", ".
  assert.equal(readVoiceDictionary(fakeStorage({ [VOICE_DICTIONARY_KEY]: ' , \n ' })), '');
});

test('raw read round-trips the user text verbatim', () => {
  // The textarea must show what the user typed, separators and all.
  const s = fakeStorage();
  writeVoiceDictionary('Vecna,\nHasura', s);
  assert.equal(readVoiceDictionaryRaw(s), 'Vecna,\nHasura');
  assert.equal(readVoiceDictionary(s), 'Vecna, Hasura');
});

test('write persists under the documented key', () => {
  const s = fakeStorage();
  writeVoiceDictionary('Vecna', s);
  assert.equal(s.map.get(VOICE_DICTIONARY_KEY), 'Vecna');
});

test('missing storage degrades to empty instead of throwing', () => {
  assert.equal(readVoiceDictionary(undefined), '');
  assert.equal(readVoiceDictionaryRaw(undefined), '');
  assert.doesNotThrow(() => writeVoiceDictionary('Vecna', undefined));
});
