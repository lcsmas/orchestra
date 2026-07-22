import React from 'react';
import { createRoot } from 'react-dom/client';
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
// Flat (Claude-Code-desktop) finish — removes the remaining hardcoded "glass"
// (gradients / backdrop-filters / gradient buttons) that don't route through the
// theme's --av-glow/--av-highlight tokens. Imported last so it wins the cascade.
import './agent-view-flat.css';
import '../shared/ipc';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
