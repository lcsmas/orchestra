// Reading an `onUserDialog` payload for presentation (#21).
//
// The payload is per-`dialogKind` and OPAQUE to the protocol — there is no
// declared shape to destructure. Rather than switch on a closed set of kinds
// (which would render nothing for any kind added later), we probe for the
// conventional presentation keys and degrade gracefully. Kept out of the .tsx
// so `node --test` can cover it without rendering React.

/** One answer button offered by a dialog payload. */
export interface UserDialogOption {
  /** The value sent back as `UserDialogResult.result`. */
  value: string;
  /** Button text. */
  label: string;
}

const TITLE_KEYS = ['title', 'header', 'heading'];
const MESSAGE_KEYS = ['message', 'body', 'text', 'prompt', 'description'];

function firstString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Turn a `dialogKind` into a readable fallback title.
 *  'refusal_fallback_prompt' → 'Refusal fallback prompt'. */
export function humanizeDialogKind(kind: string): string {
  const words = kind.replace(/[_-]+/g, ' ').trim();
  if (!words) return 'Dialog';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The title + message to show for a dialog payload. Falls back to a
 *  humanized `dialogKind` so the card always has a heading. */
export function dialogTextFromPayload(
  dialogKind: string,
  payload: Record<string, unknown>,
): { title: string; message?: string } {
  const title = firstString(payload, TITLE_KEYS) ?? humanizeDialogKind(dialogKind);
  const message = firstString(payload, MESSAGE_KEYS);
  return message === undefined ? { title } : { title, message };
}

/** Answer buttons from a dialog payload, if it offers any.
 *
 *  Accepts both conventional encodings — an array of plain strings, and an
 *  array of `{value,label}`-ish objects — because the payload shape is defined
 *  per kind and we cannot assume one. Anything else yields `[]`, which the card
 *  renders as a single Continue button rather than a dead end. */
export function dialogOptionsFromPayload(payload: Record<string, unknown>): UserDialogOption[] {
  const raw = payload.options ?? payload.choices ?? payload.buttons;
  if (!Array.isArray(raw)) return [];
  const out: UserDialogOption[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ value: item, label: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const value = [o.value, o.id, o.key].find((v) => typeof v === 'string' && v.trim());
      const label = [o.label, o.title, o.text].find((v) => typeof v === 'string' && v.trim());
      // A button needs SOMETHING to send back; label alone can serve as the
      // value, but an entry with neither is unusable and is skipped.
      const v = (value ?? label) as string | undefined;
      if (v) out.push({ value: v, label: (label as string | undefined) ?? v });
    }
  }
  return out;
}
