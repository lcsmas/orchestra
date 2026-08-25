// Voice dictation — pure shared logic (prompts, router parsing, endpointing).
//
// The pipeline design was validated in a standalone PoC (~/voice-poc) before
// landing here: local STT via parakeet-tdt-0.6b-v3 (multilingual — handles
// franglais), incremental re-decode of the live utterance for partials (the
// "industry standard" shape: partials come from the SAME model as finals, never
// from a weaker streaming model), and a Haiku LLM layer that both cleans
// dictation (fillers, punctuation, speaker dictionary) and routes inline
// corrections. Measured on the dev machine: partial cadence ~0.9s, final
// ~0.4-1.2s per utterance, LLM pass ~1.5s with a persistent worker.

/** One event flowing main -> renderer over the `voice:event` channel. */
export interface VoiceEvent {
  type:
    | 'partial' // live grey text for the CURRENT utterance (replaces previous partial)
    | 'endpoint' // silence detected; a final for the buffered utterance is coming
    | 'final' // raw STT text for one utterance (pre-LLM)
    | 'clean' // LLM-cleaned utterance; op says how to apply it
    | 'instruction' // edit mode: what the STT heard as the spoken instruction
    | 'revision' // edit mode: the revised target text
    | 'error'
    | 'state'; // engine lifecycle: listening / stopped
  text?: string;
  /** For `clean`: append after the existing text, or replace the LAST utterance
   *  (the router judged the new utterance to be an inline correction). */
  op?: 'append' | 'replace_last';
  /** Seconds the producing stage took (surfaced in the UI for trust/debug). */
  secs?: number;
}

export type VoiceMode = 'dictate' | 'edit';

/** What the composer's ghost (grey partial) should become for one voice event.
 *
 *  `null`  -> clear it, `undefined` -> leave it alone, string -> paint it.
 *
 *  Extracted pure because the ghost is the one piece of voice state the user
 *  SEES while the mic is off, and the failure is silent: several event paths
 *  are dead ends that emit no terminator (`stop()` skips `finalize()` for a
 *  sub-0.4s tail; `finalize()` returns early on an empty transcription), and a
 *  `partial` decode already in flight resolves AFTER the mic goes idle. Any of
 *  those strands grey text in the composer with the mic visibly off — which is
 *  exactly the bug this function exists to make untestable-by-inspection no
 *  longer: the invariant "mic idle => never paint a ghost" is asserted here
 *  rather than read out of a switch statement in the hook. */
export function ghostForEvent(
  ev: Pick<VoiceEvent, 'type' | 'text'>,
  micState: 'idle' | VoiceMode,
): string | null | undefined {
  // Level-triggered: whatever the engine says, an idle mic shows no ghost.
  if (micState === 'idle') return null;
  switch (ev.type) {
    case 'partial':
      // Empty text is the engine's explicit "this utterance produced nothing".
      return ev.text || null;
    case 'instruction':
      return `\u00ab ${ev.text} \u00bb`;
    case 'state':
      return ev.text === 'stopped' ? null : undefined;
    case 'clean':
    case 'revision':
    case 'error':
      return null;
    default:
      return undefined;
  }
}

/** Payload for voice:start. */
export interface VoiceStartOptions {
  mode: VoiceMode;
  /** Edit mode: the whole composer text (context only, never rewritten). */
  full?: string;
  /** Edit mode: the selection (or last utterance) — the ONLY text revised. */
  target?: string;
  /** Speaker dictionary the LLM uses to fix STT mangling ("professeur" -> "PR"). */
  vocab?: string;
}

// ---------------------------------------------------------------------------
// LLM prompts — ported verbatim from the PoC where they were validated live
// (the "Ignore all previous messages" preamble matters: the worker is one
// long-lived claude conversation, so each request must self-isolate).
// ---------------------------------------------------------------------------

export const ROUTER_PROMPT = `Ignore all previous messages in this conversation; this request is independent.
You route dictated speech for a text field. You get PREVIOUS (the last utterance already in the field, may be empty) and NEW (the freshly dictated utterance).

Decide which case NEW is:
1. An inline EDIT COMMAND about PREVIOUS — e.g. "delete the last sentence", "actually change X to Y", "non pardon, remplace X par Y", "it's Erin with an E", "make that a bullet list". Then output: {"op":"replace_last","text":"<PREVIOUS revised per the command>"}
2. Normal dictated CONTENT (the overwhelmingly common case). Then output: {"op":"append","text":"<NEW cleaned up>"}

Cleaning rules for both: remove filler words and false starts, fix punctuation/capitalization, keep the speaker's language (French stays French, English stays English — the speaker is a developer who mixes both; NEVER translate), keep technical terms, code identifiers, file paths and ticket IDs verbatim (backtick code identifiers), apply the speaker's own spoken self-corrections keeping only the corrected version.
SPEAKER DICTIONARY — the STT often mangles these terms (e.g. "professeur"/"pé air"/"PAM" in a dev context = "PR", "slac" = "Slack"); when a word sounds close to a dictionary entry and the context fits, use the dictionary spelling: {vocab}

Only choose replace_last when NEW is CLEARLY an instruction about the previous text, not content that merely mentions changing something. When in doubt: append.
Output ONLY the JSON object, no markdown fences.

PREVIOUS: {prev}
NEW: {new}`;

export const EDIT_PROMPT = `Ignore all previous messages in this conversation; this request is independent.
You are a voice text editor. Revise ONLY the TARGET passage according to the spoken INSTRUCTION. The FULL TEXT is given for context — do not rewrite it, do not touch anything outside TARGET. Keep the target's language unless told otherwise. The speaker is a developer mixing FR/EN; their dictionary (fix STT mangling toward these spellings): {vocab}. If the instruction is unintelligible or not an edit instruction, output TARGET unchanged. Output ONLY the revised target text, no quotes, no fences.

FULL TEXT: {full}
TARGET: {target}
INSTRUCTION: {instr}`;

/** Placeholder substitution that leaves the prompts' JSON braces alone
 *  (template.replace with a literal, not a format language). */
export function fillPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

/** Parse the router's JSON reply; any malformation degrades to append(fallback)
 *  so a flaky LLM reply can never eat an utterance. */
export function parseRouterReply(
  raw: string,
  fallbackText: string,
): { op: 'append' | 'replace_last'; text: string } {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    const d = JSON.parse(stripped) as { op?: unknown; text?: unknown };
    if ((d.op === 'append' || d.op === 'replace_last') && typeof d.text === 'string') {
      return { op: d.op, text: d.text };
    }
  } catch {
    /* fall through */
  }
  return { op: 'append', text: fallbackText };
}

// ---------------------------------------------------------------------------
// Energy-based endpointer.
//
// The PoC used sherpa-onnx's zipformer endpoint rules; here a plain RMS gate is
// enough because (a) push-to-talk means the mic-stop is already a hard
// endpoint, and (b) an energy gate is language-independent, which the
// monolingual zipformer was not (franglais broke its token timing). Adaptive
// noise floor: an EMA over non-speech frames, so a noisy fan doesn't read as
// speech and a quiet close-talk mic still triggers.
// ---------------------------------------------------------------------------

export interface EndpointerOptions {
  sampleRate?: number; // default 16000
  /** Silence run that closes an utterance once speech was heard. */
  silenceMs?: number; // default 800
  /** Minimum speech before an endpoint may fire (filters key-press blips). */
  minSpeechMs?: number; // default 300
  /** Speech = rms > max(absFloor, noiseFloor * ratio). */
  absFloor?: number; // default 350 (int16 RMS)
  noiseRatio?: number; // default 3
}

export class EnergyEndpointer {
  private readonly sr: number;
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly absFloor: number;
  private readonly noiseRatio: number;
  private noiseFloor = 200;
  private speechMs = 0;
  private trailingSilenceMs = 0;

  constructor(opts: EndpointerOptions = {}) {
    this.sr = opts.sampleRate ?? 16000;
    this.silenceMs = opts.silenceMs ?? 800;
    this.minSpeechMs = opts.minSpeechMs ?? 300;
    this.absFloor = opts.absFloor ?? 350;
    this.noiseRatio = opts.noiseRatio ?? 3;
  }

  /** True while the current utterance has accumulated real speech. */
  get hasSpeech(): boolean {
    return this.speechMs >= this.minSpeechMs;
  }

  /** Feed one PCM frame; returns true when an endpoint fires (and resets). */
  feed(frame: Int16Array): boolean {
    const ms = (frame.length / this.sr) * 1000;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const threshold = Math.max(this.absFloor, this.noiseFloor * this.noiseRatio);

    if (rms > threshold) {
      this.speechMs += ms;
      this.trailingSilenceMs = 0;
    } else {
      // Quiet frame: adapt the noise floor slowly toward it.
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      if (this.speechMs > 0) this.trailingSilenceMs += ms;
    }

    if (this.hasSpeech && this.trailingSilenceMs >= this.silenceMs) {
      this.reset();
      return true;
    }
    return false;
  }

  reset(): void {
    this.speechMs = 0;
    this.trailingSilenceMs = 0;
  }
}

/** Default speaker dictionary; the renderer appends workspace-derived terms
 *  (branch names, repo names) so tickets and repos transcribe right. */
export const DEFAULT_VOCAB =
  'PR, repo, merge, rebase, branch, worktree, commit, push, Slack, Linear, ' +
  'Orchestra, review, ping, ticket, deploy, staging, prod, lint, CI';

// ---------------------------------------------------------------------------
// Push-to-talk gesture arbitration
// ---------------------------------------------------------------------------

/** A press shorter than this LATCHES the mic (tap-to-toggle); anything longer
 *  is treated as push-to-talk and ends when the key comes back up. 400ms is the
 *  Wispr Flow feel: a deliberate tap latches, while the natural "hold the key,
 *  start speaking" gesture never latches by accident. */
export const VOICE_TAP_MS = 400;

/** What a key-up should do to a mic that a key-down started.
 *
 *  Pure so the tap-vs-hold rule is testable without React, a real keyboard or
 *  a mic — the timing edge cases (release arriving before the async mic start,
 *  key-repeat, a blur standing in for a lost key-up) are exactly the kind that
 *  are miserable to reproduce by hand.
 *
 *  - 'stop'   — the press was a HOLD: it is over, so stop dictating.
 *  - 'latch'  — the press was a TAP: leave the mic on until an explicit stop.
 *  - 'defer'  — the mic has not finished starting yet; re-run this once it has
 *               (dropping the release here is what strands the mic ON).
 *  - 'ignore' — this key-up does not belong to a press we started (a click
 *               started the mic, or the press already resolved). */
export type VoiceReleaseAction = 'stop' | 'latch' | 'defer' | 'ignore';

export function voiceReleaseAction(opts: {
  /** When the key went down, or null if no press is outstanding. */
  pressedAt: number | null;
  /** False while voiceStart/getUserMedia are still in flight. */
  micStarted: boolean;
  now: number;
  tapMs?: number;
}): VoiceReleaseAction {
  const { pressedAt, micStarted, now, tapMs = VOICE_TAP_MS } = opts;
  if (pressedAt === null) return 'ignore';
  if (!micStarted) return 'defer';
  return now - pressedAt >= tapMs ? 'stop' : 'latch';
}

/** Should a live PARTIAL re-decode run right now?
 *
 *  Pure so the pacing rule is testable without a mic, a model or a clock.
 *
 *  The `hasSpeech` term is the anti-hallucination guard and the reason this
 *  exists: parakeet (like whisper) does not return empty on silence — fed ~0.6s
 *  of room tone it invents a fluent sentence ("I think that's a good thing."),
 *  which the renderer then paints as a ghost. The `final` path already drops
 *  those (it emits an empty partial when the transcript is blank), but nothing
 *  clears a ghost mid-utterance, so a hallucination painted while the user is
 *  silent SITS THERE until dictation is switched off. Gating on the endpointer's
 *  own speech detector means we never ask the model about audio that has no
 *  speech in it. Reported from the real app: a ghost appeared during `écoute…`
 *  having said nothing at all. */
export function shouldDecodePartial(opts: {
  /** A decode is already in flight (partials are throwaway; never queue). */
  busy: boolean;
  /** The endpointer has accumulated >= minSpeechMs of real speech. */
  hasSpeech: boolean;
  /** Samples buffered for this utterance. */
  buffered: number;
  /** ms since the last decode FINISHED (bounds idle CPU, not decode time). */
  sinceLastDoneMs: number;
  sampleRate?: number;
  minGapMs?: number;
  /** Minimum audio before a partial is worth attempting. */
  minSeconds?: number;
}): boolean {
  const {
    busy,
    hasSpeech,
    buffered,
    sinceLastDoneMs,
    sampleRate = 16000,
    minGapMs = 1500,
    minSeconds = 0.6,
  } = opts;
  if (busy) return false;
  if (!hasSpeech) return false;
  if (sinceLastDoneMs < minGapMs) return false;
  return buffered >= sampleRate * minSeconds;
}
