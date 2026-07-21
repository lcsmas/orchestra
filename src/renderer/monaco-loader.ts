// Bundle Monaco locally instead of letting @monaco-editor/react pull it from
// the jsDelivr CDN at runtime — offline (or behind a proxy) every diff and
// code block in the app would otherwise render an empty frame. Same class of
// fix as self-hosting the UI fonts: a desktop app should not need a CDN to
// paint its own chrome.
//
// Imported ONCE from main.tsx, before any component renders an editor.
//
// Workers: our editors are read-only display surfaces (diffs, code blocks) —
// monarch tokenization/colorization runs on the main thread, so the generic
// editor worker is all we need. Language-service workers (TS intellisense,
// JSON schema validation) are deliberately not wired; they'd add megabytes to
// the bundle for features a read-only view never invokes.
import * as monaco from 'monaco-editor';
// The exports map re-roots bare subpaths at esm/vs/ — this resolves to
// esm/vs/editor/editor.worker.js; `?worker` makes vite emit it as a worker
// chunk and hand back a constructor.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { loader } from '@monaco-editor/react';

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

loader.config({ monaco });
