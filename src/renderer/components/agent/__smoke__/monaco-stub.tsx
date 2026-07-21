// Stub for @monaco-editor/react used ONLY by the render smoke harness. Monaco
// needs a real DOM + web worker, which renderToString doesn't provide; the smoke
// test only cares that our components mount and pass the right props down, so we
// render a placeholder that echoes the key props.
import React from 'react';

export default function Editor(props: Record<string, unknown>) {
  return React.createElement('div', { 'data-monaco': 'editor', 'data-lang': props.language });
}

export function DiffEditor(props: Record<string, unknown>) {
  return React.createElement('div', {
    'data-monaco': 'diff',
    'data-lang': props.language,
    'data-original': String(props.original ?? ''),
    'data-modified': String(props.modified ?? ''),
  });
}
