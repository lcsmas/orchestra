import React, { useMemo } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { inputStr } from './tool-util';
import { langFromPath } from './markdown-parse';
import { defineOrchestraThemes, useMonacoTheme, MONACO_FONT } from './monaco-theme';

interface Props {
  /** Tool name — 'Edit' or 'Write'. */
  name: string;
  input: Record<string, unknown> | undefined;
}

/**
 * A real before→after diff for a Write/Edit tool call, reconstructed entirely
 * from the tool_use INPUT (per Phase 0 spike finding g: the tool_result is plain
 * success text, so the diff MUST come from the input).
 *
 *  • **Edit** — `old_string` → `new_string` are both present in the input, so we
 *    show a genuine old→new diff of the edited region. No disk read is needed:
 *    the "before" IS `old_string`. (Orchestra exposes no renderer-side file-read
 *    IPC, so reading the whole on-disk file as context isn't available here; the
 *    edited region is the meaningful diff anyway.)
 *  • **Write** — only `content` (the new file body) exists in the input; there is
 *    no "before" to diff against, so this renders as an all-new file (empty
 *    original). Flagged in the header as "new file".
 *
 * Memoized so streaming deltas elsewhere never re-mount the Monaco diff editor.
 */
function ToolDiffImpl({ name, input }: Props) {
  const filePath = inputStr(input, 'file_path');
  const language = useMemo(() => langFromPath(filePath), [filePath]);

  const isWrite = name === 'Write';
  const original = isWrite ? '' : inputStr(input, 'old_string');
  const modified = isWrite ? inputStr(input, 'content') : inputStr(input, 'new_string');

  const lineCount = Math.max(
    original.split('\n').length,
    modified.split('\n').length
  );
  // Row height tracks MONACO_FONT.lineHeight so the frame never clips (magic
  // 18 here silently under-sized the editor once the line-height grew).
  const height = Math.min(lineCount * MONACO_FONT.lineHeight + 24, 560);
  const theme = useMonacoTheme();
  const newLines = isWrite ? modified.split('\n').length : 0;

  return (
    <div className="av-diff">
      <div className="av-diff-head">
        <span className="av-diff-path" title={filePath}>
          {filePath || '(unknown file)'}
        </span>
        <span className="av-diff-kind">
          {isWrite ? `new file · ${newLines} ${newLines === 1 ? 'line' : 'lines'}` : 'edit'}
        </span>
      </div>
      <div className="av-diff-editor" style={{ height }}>
        <DiffEditor
          original={original}
          modified={modified}
          language={language}
          theme={theme}
          beforeMount={defineOrchestraThemes}
          height="100%"
          options={{
            ...MONACO_FONT,
            readOnly: true,
            domReadOnly: true,
            renderSideBySide: false,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            folding: false,
            scrollbar: { alwaysConsumeMouseWheel: false },
            overviewRulerLanes: 0,
            renderOverviewRuler: false,
            contextmenu: false,
          }}
        />
      </div>
    </div>
  );
}

export const ToolDiff = React.memo(ToolDiffImpl);
