import React, { useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { monacoLang } from './markdown-parse';

interface Props {
  code: string;
  lang: string;
  /** Show a header strip with the language + copy button. Default true. */
  chrome?: boolean;
}

/**
 * A read-only syntax-highlighted code block. Reuses the already-bundled Monaco
 * editor rather than adding a highlighter dependency. Height auto-sizes to the
 * content (capped) so short snippets don't leave a big empty editor pane, and it
 * never grabs focus/scroll — it's a display surface, not an editor.
 *
 * Memoized so a streaming token delta on the surrounding message doesn't re-mount
 * the (relatively expensive) Monaco instance.
 */
function CodeBlockImpl({ code, lang, chrome = true }: Props) {
  const language = useMemo(() => monacoLang(lang), [lang]);
  const lineCount = useMemo(() => Math.max(1, code.split('\n').length), [code]);
  // ~18px per line + a little padding; capped so long blocks scroll internally.
  const height = Math.min(lineCount * 18 + 16, 420);

  return (
    <div className="av-code-block">
      {chrome && (
        <div className="av-code-head">
          <span className="av-code-lang">{lang || language}</span>
          <button
            className="av-code-copy"
            title="Copy"
            onClick={() => {
              void navigator.clipboard?.writeText(code);
            }}
          >
            Copy
          </button>
        </div>
      )}
      <Editor
        value={code}
        language={language}
        theme="vs-dark"
        height={height}
        options={{
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: 'off',
          folding: false,
          renderLineHighlight: 'none',
          scrollbar: { alwaysConsumeMouseWheel: false },
          overviewRulerLanes: 0,
          fontSize: 12,
          padding: { top: 6, bottom: 6 },
          wordWrap: 'on',
          contextmenu: false,
          guides: { indentation: false },
        }}
      />
    </div>
  );
}

export const CodeBlock = React.memo(CodeBlockImpl);
