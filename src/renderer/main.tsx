import React from 'react';
import { createRoot } from 'react-dom/client';
// Must run before any component renders an editor: points @monaco-editor/react
// at the BUNDLED monaco instead of its jsDelivr CDN fallback.
import './monaco-loader';
import { App } from './App';
import './styles.css';
// Structured agent-view styles — three cascade layers, LAST WINS:
//   1. agent-view-defaults.css   (A3) component structural defaults
//   2. agent-view-structure.css  (A2) layout / DOM scaffolding
//   3. agent-view-theme.css      (A5) design system — tokens + visual language,
//      imported last so it supersedes the two structural layers above.
import './agent-view-defaults.css';
import './agent-view-structure.css';
import './agent-view-theme.css';
import '../shared/ipc';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
