// The user's GLOBAL voice dictionary — extra terms the STT tends to mangle,
// fed to the LLM cleanup stage so it can snap near-misses to the right spelling
// ("professeur" -> "PR", "slac" -> "Slack").
//
// This is the user-editable third layer of the speaker dictionary. The full
// vocab handed to the LLM per utterance is:
//
//   DEFAULT_VOCAB (shared/voice.ts, hardcoded baseline)
//     + this global list (edited in Settings, persisted here)
//     + per-workspace terms (branch + repo folder, StructuredView.tsx)
//
// A renderer-side UI preference persisted in localStorage, exactly like the
// chime and default-agent-view prefs. Pure + dependency-free so it is
// node-testable and readable from both the Settings UI and the voice hook.
//
// Storage is the raw string the user typed (not a parsed array) so their own
// separators/comments survive a round-trip through the textarea; parsing to a
// clean comma-joined list happens at read time via parseVoiceDictionary.

export const VOICE_DICTIONARY_KEY = 'orchestra:voiceDictionary';

/** Split the user's free-form text into individual terms. Accepts commas,
 *  newlines and semicolons as separators (people paste lists in all three
 *  shapes), trims each entry, and drops blanks and duplicates — duplicates
 *  would otherwise waste prompt tokens and over-weight a term. Case is
 *  preserved: the dictionary's whole job is to carry the RIGHT spelling. */
export function parseVoiceDictionary(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of raw.split(/[,;\n\r]+/)) {
    const t = term.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Read the persisted dictionary as the raw text the user typed (for the
 *  textarea). `storage` is injectable for tests. */
export function readVoiceDictionaryRaw(
  storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage(),
): string {
  return storage?.getItem(VOICE_DICTIONARY_KEY) ?? '';
}

/** Read the persisted dictionary as a comma-joined term list ready to append
 *  to DEFAULT_VOCAB. Returns '' when unset or when the text holds no terms, so
 *  callers can test it for truthiness before concatenating. */
export function readVoiceDictionary(
  storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage(),
): string {
  return parseVoiceDictionary(readVoiceDictionaryRaw(storage)).join(', ');
}

/** Persist the raw text. No-op if localStorage is unavailable. */
export function writeVoiceDictionary(
  raw: string,
  storage: Pick<Storage, 'setItem'> | undefined = safeLocalStorage(),
): void {
  storage?.setItem(VOICE_DICTIONARY_KEY, raw);
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    // Accessing localStorage can throw in locked-down contexts.
    return undefined;
  }
}
