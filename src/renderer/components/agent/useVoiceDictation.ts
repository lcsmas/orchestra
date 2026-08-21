// Voice dictation controller for the composer (design "A — ghost inline").
//
// Owns the renderer half of the pipeline: a PERMANENTLY-WARM mic capture
// (getUserMedia + AudioWorklet downsampler to 16kHz Int16) with a ~600ms
// pre-roll ring buffer — Wispr-style, because spinning the pipeline up on
// keypress measurably ate the first syllable ("1469" transcribed as "469") —
// and the application of voice events to the composer text:
//
//   partial      -> ghost tail via cmRef.setGhost (never real doc text)
//   clean append -> committed text appended, utterance remembered
//   clean replace_last -> the previous utterance is revised in place (the
//                    Haiku router judged the new speech an inline correction)
//   instruction  -> ghost shows what the STT heard (edit mode)
//   revision     -> the edit target (selection, else last utterance) is spliced
//
// The mic stream stays open across dictations (the OS indicator shows it);
// tracks are only stopped on unmount.

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_VOCAB } from '../../../shared/voice';
import type { CmComposerHandle } from './CmComposer';

export type MicState = 'idle' | 'dictate' | 'edit';

const PREROLL_CHUNKS = 6; // 6 x ~100ms

/** AudioWorklet source: decimate the context rate down to 16kHz Int16 and post
 *  ~100ms chunks. Inlined as a Blob so no separate asset ships. */
const WORKLET_SRC = `
class Down extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.ratio = sampleRate / 16000; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += this.ratio) {
      const v = ch[Math.floor(i)];
      this.buf.push(Math.max(-1, Math.min(1, v)) * 32767);
    }
    if (this.buf.length >= 1600) {
      this.port.postMessage(new Int16Array(this.buf.splice(0, this.buf.length)));
    }
    return true;
  }
}
registerProcessor('down', Down);`;

export interface VoiceDictation {
  /** Local STT models present — false hides the mic UI entirely. */
  available: boolean;
  micState: MicState;
  /** One-line status for the composer bar (last stage + timing). */
  status: string | null;
  /** Toggle dictation (mode 'dictate') or voice-edit (mode 'edit'). */
  toggle: (mode: 'dictate' | 'edit') => void;
}

export function useVoiceDictation(
  workspaceId: string,
  cmRef: React.RefObject<CmComposerHandle | null>,
  setText: (updater: (prev: string) => string) => void,
  vocabExtra?: string,
): VoiceDictation {
  const [available, setAvailable] = useState(false);
  const [micState, setMicState] = useState<MicState>('idle');
  const [status, setStatus] = useState<string | null>(null);

  const micStateRef = useRef<MicState>('idle');
  micStateRef.current = micState;
  const sendingRef = useRef(false);
  const prerollRef = useRef<Int16Array[]>([]);
  const audioRef = useRef<{ ctx: AudioContext; stream: MediaStream } | null>(null);
  /** The last utterance committed by dictation — replace_last / default edit
   *  target work by string match (v1: offsets go stale if the user types). */
  const lastUtteranceRef = useRef<string>('');
  const editTargetRef = useRef<string>('');

  useEffect(() => {
    void window.orchestra.voiceAvailable().then(setAvailable);
  }, []);

  // ---- voice events -> composer text ------------------------------------
  useEffect(() => {
    const off = window.orchestra.onVoiceEvent((wsId, ev) => {
      if (wsId !== workspaceId) return;
      const cm = cmRef.current;
      switch (ev.type) {
        case 'partial':
          cm?.setGhost(ev.text ?? '', micStateRef.current === 'edit' ? 'edit' : 'dictate');
          break;
        case 'endpoint':
          setStatus('transcription…');
          break;
        case 'final':
          setStatus(`stt ${ev.secs?.toFixed(1)}s`);
          break;
        case 'clean': {
          cm?.setGhost(null);
          const t = (ev.text ?? '').trim();
          if (!t) break;
          if (ev.op === 'replace_last' && lastUtteranceRef.current) {
            const prevUtt = lastUtteranceRef.current;
            setText((prev) => {
              const at = prev.lastIndexOf(prevUtt);
              if (at < 0) return `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${t} `;
              return prev.slice(0, at) + t + prev.slice(at + prevUtt.length);
            });
          } else {
            setText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${t} `);
          }
          lastUtteranceRef.current = t;
          setStatus(`clean ${ev.secs?.toFixed(1)}s`);
          break;
        }
        case 'instruction':
          cm?.setGhost(`« ${ev.text} »`, 'edit');
          setStatus('révision…');
          break;
        case 'revision': {
          cm?.setGhost(null);
          const revised = (ev.text ?? '').trim();
          const target = editTargetRef.current;
          if (revised && target) {
            setText((prev) => {
              const at = prev.lastIndexOf(target);
              return at < 0
                ? prev
                : prev.slice(0, at) + revised + prev.slice(at + target.length);
            });
            lastUtteranceRef.current = revised;
          }
          setStatus(`révisé ${ev.secs?.toFixed(1)}s`);
          break;
        }
        case 'error':
          cm?.setGhost(null);
          setStatus(ev.text ?? 'erreur voix');
          break;
        default:
          break;
      }
    });
    return off;
  }, [workspaceId, cmRef, setText]);

  // ---- warm mic ----------------------------------------------------------
  const ensureMic = useCallback(async () => {
    if (audioRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' })),
    );
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'down');
    node.port.onmessage = (e: MessageEvent<Int16Array>) => {
      if (sendingRef.current) {
        void window.orchestra.voicePcm(workspaceId, e.data.buffer as ArrayBuffer);
      } else {
        prerollRef.current.push(e.data);
        if (prerollRef.current.length > PREROLL_CHUNKS) prerollRef.current.shift();
      }
    };
    src.connect(node);
    audioRef.current = { ctx, stream };
  }, [workspaceId]);

  useEffect(
    () => () => {
      audioRef.current?.stream.getTracks().forEach((t) => t.stop());
      void audioRef.current?.ctx.close();
      audioRef.current = null;
    },
    [],
  );

  // ---- start/stop ----------------------------------------------------------
  const toggle = useCallback(
    (mode: 'dictate' | 'edit') => {
      if (micStateRef.current !== 'idle') {
        sendingRef.current = false;
        void window.orchestra.voiceStop(workspaceId);
        setMicState('idle');
        return;
      }
      void (async () => {
        const cm = cmRef.current;
        const full = cm?.getText() ?? '';
        let target = '';
        if (mode === 'edit') {
          const sel = cm?.getSelection();
          target = sel?.text.trim() || lastUtteranceRef.current || full.trim();
          if (!target) {
            setStatus('rien à corriger');
            return;
          }
          editTargetRef.current = target;
        }
        const vocab = vocabExtra ? `${DEFAULT_VOCAB}, ${vocabExtra}` : DEFAULT_VOCAB;
        const ok = await window.orchestra.voiceStart(workspaceId, {
          mode,
          full,
          target,
          vocab,
        });
        if (!ok) {
          setStatus('modèles voix absents');
          return;
        }
        try {
          await ensureMic();
        } catch (e) {
          setStatus(`micro indisponible: ${String(e)}`);
          return;
        }
        // Flush the pre-roll so speech started at (or just before) the click is kept.
        for (const c of prerollRef.current.splice(0)) {
          void window.orchestra.voicePcm(workspaceId, c.buffer as ArrayBuffer);
        }
        sendingRef.current = true;
        setMicState(mode);
        setStatus(mode === 'edit' ? 'instruction ?' : 'écoute…');
      })();
    },
    [workspaceId, cmRef, ensureMic, vocabExtra],
  );

  return { available, micState, status, toggle };
}
