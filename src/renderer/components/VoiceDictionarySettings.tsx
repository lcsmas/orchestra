import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  parseVoiceDictionary,
  readVoiceDictionaryRaw,
  writeVoiceDictionary,
} from '../voice-dictionary';
import { DEFAULT_VOCAB } from '../../shared/voice';

interface Props {
  onClose: () => void;
}

/** Edit the GLOBAL voice dictionary — the terms the LLM cleanup stage uses to
 *  snap STT near-misses to the right spelling. Mirrors SoundSettings /
 *  AgentViewSettings: a small modal opened from the sidebar header, persisted
 *  in localStorage. Applies to the next utterance (the vocab is assembled when
 *  the mic starts), so there is nothing to restart. */
export function VoiceDictionarySettings({ onClose }: Props) {
  const [text, setText] = useState<string>(() => readVoiceDictionaryRaw());

  // Persist on every keystroke: the modal has no Cancel, exactly like the other
  // settings panes, so there is no draft state to reconcile.
  const edit = (value: string) => {
    setText(value);
    writeVoiceDictionary(value);
  };

  const terms = parseVoiceDictionary(text);

  // Portal to <body>: the sidebar carries `backdrop-filter`, which makes it a
  // CONTAINING BLOCK for position:fixed — a backdrop rendered in the tree there
  // is clipped to the 340px sidebar instead of covering the window.
  // AccountsSettings/RepoScriptsModal portal for the same reason.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sound-settings">
        <h2>Voice dictionary</h2>
        <div className="sound-hint">
          Words the transcription tends to mangle — product names, repos, ticket
          prefixes, people. Speech recognition never sees this list; it is given
          to the cleanup model, which snaps close-sounding words to your
          spelling (“slac” → “Slack”). One term per line, or comma-separated.
        </div>
        <textarea
          className="voice-dict-input"
          value={text}
          onChange={(e) => edit(e.target.value)}
          rows={8}
          spellCheck={false}
          autoFocus
          placeholder={'Vecna\nHasura\nSlimPay\nNMC'}
          aria-label="Voice dictionary terms"
        />
        <div className="voice-dict-meta">
          <span>
            {terms.length} custom {terms.length === 1 ? 'term' : 'terms'}
          </span>
          <span className="voice-dict-builtin" title={DEFAULT_VOCAB}>
            + {parseVoiceDictionary(DEFAULT_VOCAB).length} built-in, plus this
            workspace’s branch and repo name
          </span>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
