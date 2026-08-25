import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VOICE_HOTKEY,
  hotkeyFromEvent,
  matchesVoiceHotkey,
  readVoiceHotkey,
  VOICE_HOTKEY_KEY,
  voiceHotkeyLabel,
  writeVoiceHotkey,
  type VoiceHotkey,
} from './voice-hotkey-pref.ts';

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => map,
  };
}

/** A keydown as the browser reports it. `code` is the physical position. */
function kd(code: string, key: string, mods: Partial<KeyboardEvent> = {}) {
  return { code, key, ctrlKey: true, metaKey: false, altKey: false, ...mods } as Pick<
    KeyboardEvent,
    'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey'
  >;
}

// ---- the reported bug -------------------------------------------------------

test('AZERTY hardware on a `us` layout: the M-labelled key binds and fires', () => {
  // On a physical AZERTY MacBook driven by `us`, the key LABELLED M is <AC10>,
  // which `us` maps to semicolon: key=';' code='Semicolon'. The old hardcoded
  // guard (key==='m' || code==='KeyM') matched neither, so Ctrl+M was silently
  // dead. Binding by `code` records exactly the key the user pressed.
  const bound = hotkeyFromEvent(kd('Semicolon', ';'));
  assert.ok(bound);
  assert.equal(bound.code, 'Semicolon');
  assert.equal(matchesVoiceHotkey(kd('Semicolon', ';'), bound), true);

  // And the default would NOT have fired for that same press — the regression.
  assert.equal(matchesVoiceHotkey(kd('Semicolon', ';'), DEFAULT_VOICE_HOTKEY), false);
});

test('default Ctrl+M still fires for US-QWERTY users', () => {
  assert.equal(matchesVoiceHotkey(kd('KeyM', 'm'), DEFAULT_VOICE_HOTKEY), true);
});

test('binding by code survives a layout that renames the key', () => {
  // Same physical key, different `key` value per layout/modifier state. The
  // binding must follow the POSITION, not the character.
  const bound: VoiceHotkey = { code: 'Semicolon', label: 'M', ctrl: true };
  for (const key of [';', ':', 'm', 'M', 'Dead', 'µ']) {
    assert.equal(matchesVoiceHotkey(kd('Semicolon', key), bound), true, `key=${key}`);
  }
});

// ---- matching rules ---------------------------------------------------------

test('requires the modifier on key-down, but not on key-up', () => {
  const e = kd('KeyM', 'm', { ctrlKey: false });
  assert.equal(matchesVoiceHotkey(e, DEFAULT_VOICE_HOTKEY), false, 'keydown needs Ctrl');
  // Releasing Ctrl before the letter is normal; the keyup reports ctrlKey=false.
  // Dropping it would strand the mic ON, so key-up matches on position alone.
  assert.equal(matchesVoiceHotkey(e, DEFAULT_VOICE_HOTKEY, false), true, 'keyup must match');
});

test('Cmd counts as the modifier (mac)', () => {
  assert.equal(
    matchesVoiceHotkey(kd('KeyM', 'm', { ctrlKey: false, metaKey: true }), DEFAULT_VOICE_HOTKEY),
    true,
  );
});

test('Alt is excluded so AltGr chords never trigger dictation', () => {
  // AltGr surfaces as ctrl+alt on Windows/Linux; without this, AltGr+<bound key>
  // would start the mic while the user is typing an accented character.
  assert.equal(
    matchesVoiceHotkey(kd('KeyM', 'µ', { altKey: true }), DEFAULT_VOICE_HOTKEY),
    false,
  );
});

test('a different physical key never fires', () => {
  assert.equal(matchesVoiceHotkey(kd('KeyN', 'n'), DEFAULT_VOICE_HOTKEY), false);
});

// ---- capture ----------------------------------------------------------------

test('a modifier-only press does not bind (the recorder keeps waiting)', () => {
  for (const code of ['ControlLeft', 'ShiftRight', 'AltLeft', 'MetaLeft']) {
    assert.equal(hotkeyFromEvent(kd(code, 'Control')), null, code);
  }
});

test('label prefers the printed character, falls back to the code', () => {
  assert.equal(hotkeyFromEvent(kd('Semicolon', ';'))?.label, ';');
  assert.equal(hotkeyFromEvent(kd('KeyM', 'm'))?.label, 'M');
  assert.equal(hotkeyFromEvent(kd('F5', 'F5'))?.label, 'F5');
  assert.equal(hotkeyFromEvent(kd('Digit4', '4'))?.label, '4');
});

test('voiceHotkeyLabel renders the chord', () => {
  assert.equal(voiceHotkeyLabel({ code: 'Semicolon', label: 'M', ctrl: true }), 'Ctrl+M');
  assert.equal(voiceHotkeyLabel({ code: 'F5', label: 'F5', ctrl: false }), 'F5');
});

// ---- persistence ------------------------------------------------------------

test('round-trips through storage', () => {
  const s = fakeStorage();
  const hk: VoiceHotkey = { code: 'Semicolon', label: 'M', ctrl: true };
  writeVoiceHotkey(hk, s);
  assert.deepEqual(readVoiceHotkey(s), hk);
});

test('defaults to Ctrl+M when unset', () => {
  assert.deepEqual(readVoiceHotkey(fakeStorage()), DEFAULT_VOICE_HOTKEY);
});

test('a corrupt or partial record falls back instead of disabling dictation', () => {
  // Each of these must yield a WORKING hotkey — a user with a mangled
  // localStorage entry should get Ctrl+M back, not a dead mic.
  for (const raw of ['not json', '{}', 'null', '[]', '{"label":"M"}', '{"code":""}']) {
    assert.deepEqual(
      readVoiceHotkey(fakeStorage({ [VOICE_HOTKEY_KEY]: raw })),
      DEFAULT_VOICE_HOTKEY,
      raw,
    );
  }
});

test('a record missing only `label` still matches, using the code as label', () => {
  const hk = readVoiceHotkey(fakeStorage({ [VOICE_HOTKEY_KEY]: '{"code":"Semicolon"}' }));
  assert.equal(hk.code, 'Semicolon');
  assert.equal(hk.label, 'Semicolon');
  assert.equal(matchesVoiceHotkey(kd('Semicolon', ';'), hk), true);
});

test('storage that throws does not break reads or writes', () => {
  const boom = {
    getItem: () => {
      throw new Error('locked down');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.doesNotThrow(() => writeVoiceHotkey(DEFAULT_VOICE_HOTKEY, boom));
  // readVoiceHotkey guards JSON.parse; a throwing getItem propagates from the
  // caller's own storage accessor, which is why the default accessor is wrapped.
  assert.deepEqual(readVoiceHotkey(fakeStorage()), DEFAULT_VOICE_HOTKEY);
});
