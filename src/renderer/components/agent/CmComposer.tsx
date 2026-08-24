// The composer's text surface: a CodeMirror 6 editor that replaces the old
// textarea + highlight-mirror pair.
//
// WHY CodeMirror rather than a textarea: a textarea cannot style a substring
// (the old build painted `/skill` via a transparent-text textarea over a mirror
// div whose text metrics had to be kept byte-identical), and it cannot support
// modal editing at all. CM gives us decorations for the token highlight and a
// maintained vim mode for free.
//
// Every non-obvious line below was forced by a real integration collision found
// by driving a prototype; each carries the measurement that produced it.

import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  EditorState,
  RangeSetBuilder,
  Compartment,
  Prec,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as cmPlaceholder,
  drawSelection,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { vim, Vim, getCM } from '@replit/codemirror-vim';
import { highlightComposer } from '../../../shared/composer-highlight';
import { isMiddleClickPaste } from '../../../shared/middle-click-paste';
import type { VimMode } from '../../composer-vim-pref';

/** Token decorations — the SAME class names the old mirror used, so
 *  `agent-view-theme.css` styles them unchanged. */
const SKILL_MARK = Decoration.mark({ class: 'av-composer-token av-composer-token-skill' });
const BASH_MARK = Decoration.mark({ class: 'av-composer-token av-composer-token-bash' });

/** Paint the leading `/skill` or `!bash` token, reusing the shared tokenizer so
 *  the highlight and any other consumer can never disagree. */
const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  // Only the FIRST line can carry the prefix — `highlightComposer` anchors at
  // the start, so a `/` on line 3 is prose, not a command.
  const first = view.state.doc.line(1).text;
  let at = 0;
  for (const part of highlightComposer(first)) {
    if (part.token === 'skill') b.add(at, at + part.text.length, SKILL_MARK);
    else if (part.token === 'bash') b.add(at, at + part.text.length, BASH_MARK);
    at += part.text.length;
  }
  return b.finish();
}

/** Orchestra's palette applied to CodeMirror's own surfaces.
 *
 *  This must NOT be wrapped in `Prec.highest`: `EditorView.theme()` returns
 *  FACET VALUES (`theme.of`, `darkTheme.of`) alongside its style module, and
 *  precedence-wrapping those stops them registering — which silently dropped
 *  both `dark: true` and every `.cm-panels` rule (measured: the ex-command bar
 *  stayed #f5f5f5 white). CSS specificity, not extension precedence, is what
 *  makes these win. */
const orchestraTheme = EditorView.theme(
  {
    '&': { color: 'var(--av-text)', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
      padding: '5px 0',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--av-fs-code)',
      lineHeight: '1.6',
      caretColor: 'var(--av-text)',
    },
    '.cm-line': { padding: '0' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
      // Auto-grow up to the same cap the textarea used, then scroll.
      maxHeight: '200px',
      overflowY: 'auto',
    },
    '.cm-placeholder': { color: 'var(--av-text-faint)' },
    // Insert-mode caret. Set here rather than in a stylesheet: CM injects its
    // own scoped rules that outrank plain CSS, which is why an external
    // `caret-color` left the caret rendering BLACK.
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--av-text)',
      borderLeftWidth: '2px',
    },
    // Vim's NORMAL/VISUAL block cursor lives in its own layer and is hard-coded
    // #ff9696 by a Prec.highest theme in the vim package — recolour it.
    '.cm-vimCursorLayer .cm-fat-cursor': {
      background: 'rgba(110, 168, 255, 0.5)',
      color: 'var(--av-text)',
    },
    '&:not(.cm-focused) .cm-vimCursorLayer .cm-fat-cursor': {
      background: 'none',
      outline: '1px solid rgba(110, 168, 255, 0.8)',
    },
    // Selection. CM's built-in theme ships
    //   .ͼ2.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground
    // whose child combinators outrank a flat selector, so a plain
    // `.cm-selectionBackground` rule loses and visual-mode selections rendered
    // in CM's default lavender (or not at all). Match its shape.
    '.cm-selectionLayer .cm-selectionBackground': {
      background: 'rgba(110, 168, 255, 0.30)',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      background: 'rgba(110, 168, 255, 0.40)',
    },
    // Vim's ex-command / search line (`:` and `/`). CM's `.cm-panels` default is
    // a LIGHT #f5f5f5 bar and vim's own baseTheme sets only padding/monospace on
    // `.cm-vim-panel` (its input inherits background with NO colour), so this
    // rendered as a white slab with black Arial text across the dark composer.
    '.cm-panels': {
      backgroundColor: 'var(--av-surface-raised)',
      color: 'var(--av-text)',
      border: 'none',
    },
    '.cm-panels-bottom': { borderTop: '1px solid var(--av-hairline)' },
    '.cm-vim-panel': {
      padding: '4px 12px',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--av-fs-code)',
      color: 'var(--av-text)',
      backgroundColor: 'transparent',
    },
    '.cm-vim-panel span': { color: 'var(--av-assistant)' },
    '.cm-vim-panel input': {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--av-fs-code)',
      color: 'var(--av-text)',
      caretColor: 'var(--av-text)',
      backgroundColor: 'transparent',
      border: 'none',
      outline: 'none',
      flex: '1',
    },
    // Vim's search highlight is `&light` yellow vs `&dark` cyan; pin it to the
    // app's accent so `/foo` doesn't paint highlighter-yellow on a dark surface.
    '.cm-searchMatch': { backgroundColor: 'rgba(139, 124, 255, 0.32)' },
    '.cm-searchMatch-selected': { backgroundColor: 'rgba(139, 124, 255, 0.55)' },
  },
  { dark: true },
);

// ---------------------------------------------------------------------------
// Voice-dictation ghost tail (design "A — ghost inline"): live STT partials
// render as a grey-italic WIDGET pinned to the end of the doc — never real
// document text, so they can't be sent, edited, or pollute undo history. The
// widget is swapped for committed text only when the cleaned utterance arrives.
// ---------------------------------------------------------------------------

const setGhostEffect = StateEffect.define<{ text: string; kind: 'dictate' | 'edit' } | null>();

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly kind: 'dictate' | 'edit',
  ) {
    super();
  }
  override eq(o: GhostWidget): boolean {
    return o.text === this.text && o.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = `av-ghost av-ghost-${this.kind}`;
    s.textContent = this.text;
    return s;
  }
}

const ghostField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhostEffect)) {
        return e.value
          ? Decoration.set([
              Decoration.widget({
                widget: new GhostWidget(e.value.text, e.value.kind),
                side: 1,
              }).range(tr.newDoc.length),
            ])
          : Decoration.none;
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface CmComposerHandle {
  focus: () => void;
  getText: () => string;
  setText: (text: string) => void;
  /** Voice dictation: render (or clear, with null) the ghost partial tail. */
  setGhost: (text: string | null, kind?: 'dictate' | 'edit') => void;
  /** Current primary selection — voice edit mode scopes its revision to it. */
  getSelection: () => { from: number; to: number; text: string };
}

interface Props {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  vimEnabled: boolean;
  /** Reports vim's current mode so the composer bar's chip can render it. */
  onVimMode: (mode: VimMode | null) => void;
  /** Key handlers, highest precedence — they beat both vim and CM defaults.
   *  Each returns true when it consumed the key. */
  onEnter: () => boolean;
  onShiftEnter?: () => boolean;
  /** Mod(Cmd/Ctrl)+Enter — interrupt the running turn and send immediately,
   *  bypassing the queue. */
  onModEnter?: () => boolean;
  onArrowDown: () => boolean;
  onArrowUp: () => boolean;
  onTab: () => boolean;
  /** Esc: receives the current vim mode so the caller can implement the
   *  context-dependent behaviour (leave INSERT/VISUAL vs interrupt the turn). */
  onEscape: (mode: VimMode | null) => boolean;
  onPaste: (items: DataTransferItemList | null) => boolean;
  onDrop: (e: DragEvent) => void;
  /** Ctrl+M — toggle voice dictation. Optional: absent (or returning false)
   *  when the voice models aren't installed, so the chord types nothing. */
  onVoiceDictate?: () => boolean;
  /** Ctrl+Shift+M — toggle voice EDIT (revise selection / last utterance). */
  onVoiceEdit?: () => boolean;
  handleRef?: (h: CmComposerHandle | null) => void;
}

export function CmComposer({
  value,
  onChange,
  placeholder,
  vimEnabled,
  onVimMode,
  onEnter,
  onShiftEnter,
  onModEnter,
  onArrowDown,
  onArrowUp,
  onTab,
  onEscape,
  onPaste,
  onDrop,
  onVoiceDictate,
  onVoiceEdit,
  handleRef,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const vimComp = useRef(new Compartment());
  const baseKeymapComp = useRef(new Compartment());
  // timeStamp of the last middle-button mousedown, or null when disarmed.
  const middleClickAt = useRef<number | null>(null);
  // Latest callbacks, read through a ref so the keymap closure never goes stale
  // (the editor is created once; props change every render).
  const cb = useRef({
    onChange, onEnter, onShiftEnter, onModEnter, onArrowDown, onArrowUp, onTab, onEscape,
    onPaste, onDrop, onVimMode, vimEnabled, onVoiceDictate, onVoiceEdit,
  });
  cb.current = {
    onChange, onEnter, onShiftEnter, onModEnter, onArrowDown, onArrowUp, onTab, onEscape,
    onPaste, onDrop, onVimMode, vimEnabled, onVoiceDictate, onVoiceEdit,
  };

  /** Current vim mode, or null when vim is off. */
  const readMode = (view: EditorView): VimMode | null => {
    if (!cb.current.vimEnabled) return null;
    const v = getCM(view)?.state?.vim;
    if (!v) return null;
    return v.insertMode ? 'insert' : v.visualMode ? 'visual' : 'normal';
  };

  /** Enter INSERT. `vim()` has no start-in-insert option and initialises in
   *  NORMAL, so without this a user typing "hello" runs h/e/l/l/o as COMMANDS
   *  (measured: the doc became a bare newline). A chat composer must open ready
   *  to type; Esc still reaches NORMAL. */
  const enterInsertMode = (view: EditorView) => {
    const cm = getCM(view);
    if (!cm?.state?.vim || cm.state.vim.insertMode) return;
    Vim.handleKey(cm, 'i', 'user');
  };

  // Create the editor once.
  useEffect(() => {
    if (!host.current) return;
    const keys = Prec.highest(
      keymap.of([
        { key: 'ArrowDown', run: () => cb.current.onArrowDown() },
        { key: 'ArrowUp', run: () => cb.current.onArrowUp() },
        { key: 'Tab', run: () => cb.current.onTab() },
        {
          key: 'Enter',
          run: (v) => {
            // In vim NORMAL, Enter is a MOTION (next line), not "send" —
            // hijacking it would break normal-mode navigation.
            if (readMode(v) === 'normal') return false;
            return cb.current.onEnter();
          },
          shift: () => (cb.current.onShiftEnter ? cb.current.onShiftEnter() : false),
        },
        {
          // Mod+Enter = "interrupt the running turn and send this NOW", the
          // escape hatch from the default queue-on-Enter behaviour. NOT bound to
          // Shift+Enter: that already inserts a newline, and stealing it would
          // break multi-line prompts.
          key: 'Mod-Enter',
          run: (v) => {
            if (readMode(v) === 'normal') return false;
            return cb.current.onModEnter ? cb.current.onModEnter() : false;
          },
        },
        {
          // Ctrl+[ is vim's Esc synonym. `defaultKeymap` binds `Mod-[` to
          // indentLess and Mod IS Ctrl on Linux/Windows, so the chord was
          // consumed before vim ever saw it (measured: vim's handleKey received
          // Escape but never Ctrl+[). Claim it and forward.
          key: 'Ctrl-[',
          run: (v) => {
            if (!cb.current.vimEnabled) return false;
            const cm = getCM(v);
            if (!cm) return false;
            Vim.handleKey(cm, '<Esc>', 'user');
            return true;
          },
        },
        { key: 'Escape', run: (v) => cb.current.onEscape(readMode(v)) },
        // Voice dictation chords. Letters with Ctrl so they can never collide
        // with typing (insert mode) — and claimed at highest precedence so vim
        // (Ctrl-m = carriage-return motion in NORMAL) doesn't eat them.
        //
        // These are a FALLBACK, and normally never fire: StructuredView owns
        // Ctrl-M window-wide (capture phase, so the mic works while focus is in
        // a diff or terminal) and calls stopPropagation, which means CodeMirror
        // is not reached while that listener is installed. They still matter as
        // the vim claim — without them vim would bind Ctrl-m to its
        // carriage-return motion — and they keep the composer working if the
        // window-level handler is ever gated off. Deliberately still a TOGGLE:
        // a CodeMirror keymap sees no keyup, so it cannot express hold-to-talk.
        { key: 'Ctrl-m', run: () => cb.current.onVoiceDictate?.() ?? false },
        { key: 'Ctrl-Shift-m', run: () => cb.current.onVoiceEdit?.() ?? false },
      ]),
    );

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          keys,
          vimComp.current.of(vimEnabled ? vim() : []),
          // `defaultKeymap` steals ~20 chords vim needs (Ctrl-b/f/d/o/v/a/e/p/n,
          // Mod-[, Mod-]), so it is dropped entirely while vim is on. History
          // (undo/redo) stays either way.
          baseKeymapComp.current.of(
            keymap.of(vimEnabled ? historyKeymap : [...historyKeymap, ...defaultKeymap]),
          ),
          history(),
          // Renders `.cm-selectionBackground`; without it CM uses NATIVE browser
          // selection, which vim's visual mode does not drive — so visual
          // selections painted nothing at all.
          drawSelection({ cursorBlinkRate: 1200 }),
          orchestraTheme,
          highlighter,
          ghostField,
          cmPlaceholder(placeholder),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            cb.current.onVimMode(readMode(u.view));
          }),
          EditorView.domEventHandlers({
            // Middle-click (button 1) on Linux pastes the PRIMARY selection —
            // text merely *selected* anywhere on the system, no copy involved.
            // On a clickpad that fires by accident: a trackpad using
            // `click_method=clickfinger` (the default on Apple hardware) maps a
            // PHYSICAL click with three fingers resting on the pad to button 2,
            // so brushing the pad with a third finger while clicking silently
            // dumps the last-selected text into the prompt. Record the click and
            // swallow the paste it triggers; see the `paste` handler below.
            mousedown: (e) => {
              if (e.button === 1) middleClickAt.current = e.timeStamp;
              return false;
            },
            paste: (e) => {
              // A paste arriving right after a middle click is that click's
              // primary-selection paste (measured latency ~2ms). Drop it.
              // Ctrl+V / Cmd+V / the context menu are uncorrelated with a middle
              // click and fall through untouched.
              if (isMiddleClickPaste(middleClickAt.current, e.timeStamp)) {
                middleClickAt.current = null;
                e.preventDefault();
                return true;
              }
              if (cb.current.onPaste(e.clipboardData?.items ?? null)) {
                e.preventDefault();
                return true;
              }
              return false;
            },
            drop: (e) => {
              cb.current.onDrop(e);
              return false;
            },
            // vim swallows keys before React sees them, so mode changes need
            // their own pump to keep the chip live.
            keyup: (_e, v) => {
              cb.current.onVimMode(readMode(v));
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    // E2E seam, mirroring `__orchestraSetState` / `__injectAgentEvent`: CM keeps
    // no handle to its EditorView on the DOM, so a CDP drive cannot read the doc
    // or reset it between assertions without this. Read-only debugging aid.
    (window as unknown as { __cmComposerView?: EditorView }).__cmComposerView = view;
    if (vimEnabled) enterInsertMode(view);
    cb.current.onVimMode(readMode(view));
    handleRef?.({
      focus: () => view.focus(),
      getText: () => view.state.doc.toString(),
      setText: (text: string) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
        });
      },
      setGhost: (text, kind = 'dictate') => {
        view.dispatch({ effects: setGhostEffect.of(text ? { text, kind } : null) });
      },
      getSelection: () => {
        const r = view.state.selection.main;
        return { from: r.from, to: r.to, text: view.state.doc.sliceString(r.from, r.to) };
      },
    });
    return () => {
      handleRef?.(null);
      const w = window as unknown as { __cmComposerView?: EditorView };
      if (w.__cmComposerView === view) delete w.__cmComposerView;
      view.destroy();
      viewRef.current = null;
    };
    // Created once on mount; `value`/`placeholder` are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled-value sync: push external changes (skill completion, clearing
  // after send) into the doc without clobbering what the user is typing.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === value) return;
    view.dispatch({
      changes: { from: 0, to: cur.length, insert: value },
      selection: { anchor: value.length },
    });
  }, [value]);

  // Toggle vim without recreating the editor (keeps the doc + undo history).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        vimComp.current.reconfigure(vimEnabled ? vim() : []),
        baseKeymapComp.current.reconfigure(
          keymap.of(vimEnabled ? historyKeymap : [...historyKeymap, ...defaultKeymap]),
        ),
      ],
    });
    if (vimEnabled) {
      // Land in INSERT after the reconfigure commits.
      setTimeout(() => {
        enterInsertMode(view);
        cb.current.onVimMode(readMode(view));
      }, 0);
    } else {
      cb.current.onVimMode(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vimEnabled]);

  return <div className="av-composer-cm" ref={host} />;
}
