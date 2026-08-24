// Voice dictation engine (design "A — ghost inline", chosen from the PoC).
//
// The renderer captures mic PCM (16kHz mono Int16) and streams it here over
// IPC; this module runs the pipeline validated in the ~/voice-poc standalone:
//
//   PCM ─▶ EnergyEndpointer ─▶ utterance buffer
//            │                    │ every ~1s while speaking: parakeet-cli on the
//            │                    │ WHOLE buffer -> `partial` (same model as the
//            │                    │ final, so partials handle franglais)
//            │ endpoint / stop ──▶ parakeet-cli -> `final` -> Haiku router ->
//            │                     `clean` {op: append | replace_last}
//            └ edit mode: final text is a spoken INSTRUCTION -> Haiku edit ->
//              `revision` (applies to the renderer-chosen target only)
//
// The LLM stage is a PERSISTENT `claude -p --input-format stream-json` worker
// (haiku): a cold CLI spawn measured ~6s per call, the warm worker ~1.5s.
//
// Availability is gated on the PoC's binaries/models existing on disk
// (ORCHESTRA_VOICE_DIR, default ~/voice-poc). No models -> the renderer simply
// hides the mic button. This keeps the feature dev-machine-only until the
// models ship with the app.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { platform } from './platform';
import { scoped } from './logger';
import {
  EnergyEndpointer,
  ROUTER_PROMPT,
  EDIT_PROMPT,
  DEFAULT_VOCAB,
  fillPrompt,
  parseRouterReply,
  type VoiceEvent,
  type VoiceStartOptions,
} from '../shared/voice.ts';

const log = scoped('voice');

const VOICE_DIR = process.env.ORCHESTRA_VOICE_DIR || join(homedir(), 'voice-poc');
const PARAKEET_BIN = join(VOICE_DIR, 'whisper.cpp/build/bin/parakeet-cli');
const PARAKEET_MODEL = join(VOICE_DIR, 'models/ggml-parakeet-tdt-0.6b-v3-f16.bin');
const SAMPLE_RATE = 16000;

// ---------------------------------------------------------------------------
// Partial-decode budget.
//
// Live `partial`s re-decode the ENTIRE utterance-so-far on every pass, so their
// cost grows with utterance length while the user is still speaking. The
// original pacing was skip-if-busy only: the next decode launched the moment
// the previous one returned, giving parakeet a ~100% duty cycle at 8 threads
// (measured 284% CPU on this machine — the audible fan). Two knobs tame it
// without giving up the ghost text:
//
//   PARTIAL_MIN_GAP_MS — a floor between the END of one decode and the START of
//     the next, so partials are paced by the clock instead of by however fast
//     the CPU can churn. ~1.5s still tracks speech usefully (a partial per
//     phrase, not per syllable).
//   PARTIAL_THREADS    — partials are throwaway (superseded within seconds and
//     never inserted as real text), so they get half the threads. The FINAL
//     decode, whose latency the user actually waits on, keeps all 8.
const PARTIAL_MIN_GAP_MS = 1500;
const PARTIAL_THREADS = 4;
const FINAL_THREADS = 8;

export function voiceAvailable(): boolean {
  return existsSync(PARAKEET_BIN) && existsSync(PARAKEET_MODEL);
}

// ---------------------------------------------------------------------------
// Persistent Haiku worker (one per app, lazily started, restarted on death).
// ---------------------------------------------------------------------------

class HaikuWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private buffer = '';
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;

  private ensure(): void {
    if (this.proc && this.proc.exitCode === null) return;
    this.buffer = '';
    this.proc = spawn(
      'claude',
      ['-p', '--model', 'haiku', '--input-format', 'stream-json',
       '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'],
      { env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'orchestra-voice' }, stdio: 'pipe' },
    );
    this.proc.stdout.on('data', (d: Buffer) => this.onData(d));
    this.proc.on('exit', (code) => {
      log.info(`haiku worker exited (${code})`);
      this.pending?.reject(new Error('voice LLM worker died'));
      this.pending = null;
      this.proc = null;
    });
    this.proc.stderr.on('data', () => {});
    log.info('haiku worker started');
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString();
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      try {
        const ev = JSON.parse(line) as { type?: string; result?: string };
        if (ev.type === 'result' && this.pending) {
          this.pending.resolve((ev.result ?? '').trim());
          this.pending = null;
        }
      } catch {
        /* non-JSON noise */
      }
    }
  }

  /** Serialized ask — the worker is one conversation, one request in flight. */
  ask(prompt: string, timeoutMs = 30_000): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        this.ensure();
        if (!this.proc) return reject(new Error('voice LLM worker unavailable'));
        this.pending = { resolve, reject };
        const timer = setTimeout(() => {
          if (this.pending) {
            this.pending = null;
            reject(new Error('voice LLM timeout'));
          }
        }, timeoutMs);
        const settle = <T,>(v: T): T => (clearTimeout(timer), v);
        this.pending = {
          resolve: (s) => resolve(settle(s)),
          reject: (e) => reject(settle(e)),
        };
        this.proc.stdin.write(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: prompt }] },
          }) + '\n',
        );
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

const worker = new HaikuWorker();

// ---------------------------------------------------------------------------
// Parakeet transcription (spawn per call — measured 0.4-1.2s incl. model mmap).
// ---------------------------------------------------------------------------

function writeWav(dir: string, pcm: Int16Array): string {
  const path = join(dir, `utt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const header = Buffer.alloc(44);
  const dataLen = pcm.length * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataLen)]));
  return path;
}

function transcribe(
  dir: string,
  pcm: Int16Array,
  threads = FINAL_THREADS,
): Promise<{ text: string; secs: number }> {
  return new Promise((resolve) => {
    const wav = writeWav(dir, pcm);
    const t0 = Date.now();
    const p = spawn(PARAKEET_BIN, ['-m', PARAKEET_MODEL, '-t', String(threads), '-np', '-f', wav]);
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', (code) => {
      rmSync(wav, { force: true });
      resolve({
        text: code === 0 ? out.trim() : '',
        secs: (Date.now() - t0) / 1000,
      });
    });
    p.on('error', () => {
      rmSync(wav, { force: true });
      resolve({ text: '', secs: (Date.now() - t0) / 1000 });
    });
  });
}

// ---------------------------------------------------------------------------
// Per-workspace session.
// ---------------------------------------------------------------------------

class VoiceSession {
  private chunks: Int16Array[] = [];
  private endpointer = new EnergyEndpointer();
  private gen = 0; // bumped per utterance; stale incremental decodes are dropped
  private incrBusy = false;
  /** When the last incremental decode FINISHED. 0 = never, so the first partial
   *  of a session fires as soon as 0.6s of audio exists rather than waiting out
   *  a gap that no decode has earned yet. Reset per utterance for the same
   *  reason: each new utterance should paint its first ghost promptly. */
  private lastIncrDoneAt = 0;
  private lastClean = '';
  private readonly tmp: string;

  constructor(
    private readonly wsId: string,
    private opts: VoiceStartOptions,
  ) {
    this.tmp = mkdtempSync(join(tmpdir(), 'orchestra-voice-'));
  }

  configure(opts: VoiceStartOptions): void {
    this.opts = opts;
  }

  private emit(ev: VoiceEvent): void {
    platform.broadcast('voice:event', this.wsId, ev);
  }

  onPcm(chunk: Int16Array): void {
    this.chunks.push(chunk);
    const endpoint = this.endpointer.feed(chunk);

    // Incremental partial: re-decode the whole buffer. Paced by BOTH skip-if-
    // busy and a wall-clock floor since the last decode finished — busy alone
    // let parakeet run back-to-back at ~100% duty cycle (see PARTIAL_MIN_GAP_MS).
    const buffered = this.chunks.reduce((n, c) => n + c.length, 0);
    const rested = Date.now() - this.lastIncrDoneAt >= PARTIAL_MIN_GAP_MS;
    if (!this.incrBusy && rested && buffered >= SAMPLE_RATE * 0.6) {
      this.incrBusy = true;
      const gen = this.gen;
      void transcribe(this.tmp, concat(this.chunks), PARTIAL_THREADS).then(({ text }) => {
        this.incrBusy = false;
        // Stamp on COMPLETION, not on start: the gap we want to bound is idle
        // CPU time between decodes, and a long decode has already spent the
        // budget its own runtime represents.
        this.lastIncrDoneAt = Date.now();
        if (gen === this.gen && text) this.emit({ type: 'partial', text });
      });
    }

    // Edit mode finalizes ONLY on stop (mic release): a silence endpoint firing
    // mid-instruction would run the revision on half a sentence — observed in
    // the e2e drive ("« with planet »" heard from "replace the word country
    // with planet"). Wispr's command mode is release-triggered for the same
    // reason. Dictate mode keeps flowing utterance-by-utterance.
    if (endpoint && this.opts.mode !== 'edit') {
      const pcm = concat(this.chunks);
      this.chunks = [];
      this.gen++;
      // New utterance: let its first partial fire immediately instead of
      // inheriting the previous utterance's cooldown.
      this.lastIncrDoneAt = 0;
      if (pcm.length > SAMPLE_RATE * 0.4) {
        this.emit({ type: 'endpoint' });
        void this.finalize(pcm);
      } else {
        // Too short to transcribe: no `final`/`clean` will follow, so tell the
        // renderer to drop the ghost partial this utterance already painted.
        this.emit({ type: 'partial', text: '' });
      }
    }
  }

  stop(): void {
    const pcm = concat(this.chunks);
    this.chunks = [];
    this.gen++;
    if (pcm.length > SAMPLE_RATE * 0.4) void this.finalize(pcm);
    this.emit({ type: 'state', text: 'stopped' });
  }

  dispose(): void {
    this.gen++;
    rmSync(this.tmp, { recursive: true, force: true });
  }

  private async finalize(pcm: Int16Array): Promise<void> {
    const { text: final, secs } = await transcribe(this.tmp, pcm);
    if (!final) {
      // Nothing was heard. Clear the ghost the partials painted, otherwise it
      // stays on screen with the mic already off.
      this.emit({ type: 'partial', text: '' });
      return;
    }
    const vocab = this.opts.vocab || DEFAULT_VOCAB;

    if (this.opts.mode === 'edit') {
      this.emit({ type: 'instruction', text: final, secs });
      const t0 = Date.now();
      try {
        const revised = await worker.ask(
          fillPrompt(EDIT_PROMPT, {
            full: this.opts.full ?? '',
            target: this.opts.target ?? '',
            instr: final,
            vocab,
          }),
        );
        this.emit({ type: 'revision', text: revised, secs: (Date.now() - t0) / 1000 });
        this.lastClean = revised;
      } catch (e) {
        this.emit({ type: 'error', text: `edit failed: ${String(e)}` });
      }
      return;
    }

    this.emit({ type: 'final', text: final, secs });
    const t0 = Date.now();
    try {
      const raw = await worker.ask(
        fillPrompt(ROUTER_PROMPT, { prev: this.lastClean || '(empty)', new: final, vocab }),
      );
      const routed = parseRouterReply(raw, final);
      this.emit({ type: 'clean', ...routed, secs: (Date.now() - t0) / 1000 });
      if (routed.text) this.lastClean = routed.text;
    } catch (e) {
      log.warn(`router failed, appending raw: ${String(e)}`);
      this.emit({ type: 'clean', op: 'append', text: final, secs: 0 });
      this.lastClean = final;
    }
  }
}

function concat(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// IPC wiring — registered inline (like pickDirectory) rather than through the
// api-handlers table: voice is frontend-local, high-frequency, and gated on
// dev-machine models.
// ---------------------------------------------------------------------------

const sessions = new Map<string, VoiceSession>();

export function initVoice(): void {
  ipcMain.handle('voice:available', () => voiceAvailable());

  ipcMain.handle('voice:start', (_e, wsId: string, opts: VoiceStartOptions) => {
    if (!voiceAvailable()) return false;
    let s = sessions.get(wsId);
    if (!s) {
      s = new VoiceSession(wsId, opts);
      sessions.set(wsId, s);
    } else {
      s.configure(opts);
    }
    platform.broadcast('voice:event', wsId, { type: 'state', text: 'listening' });
    return true;
  });

  ipcMain.handle('voice:pcm', (_e, wsId: string, buf: ArrayBuffer) => {
    sessions.get(wsId)?.onPcm(new Int16Array(buf));
  });

  ipcMain.handle('voice:stop', (_e, wsId: string) => {
    sessions.get(wsId)?.stop();
  });
}

export function disposeVoice(): void {
  for (const s of sessions.values()) s.dispose();
  sessions.clear();
}
