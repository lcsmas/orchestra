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
