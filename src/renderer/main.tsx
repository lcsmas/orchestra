import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
// A3: structural defaults for the agent-view components, imported BEFORE
// agent-view.css so A2's/A5's rules win on overlap (A5 reconciles final order).
import './agent-view-defaults.css';
import './agent-view.css';
import '../shared/ipc';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
