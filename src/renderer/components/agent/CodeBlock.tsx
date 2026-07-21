import React, { useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { monacoLang } from './markdown-parse';
import { defineOrchestraThemes, useMonacoTheme, MONACO_FONT } from './monaco-theme';

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
  const theme = useMonacoTheme();
  const [copied, setCopied] = useState(false);

  return (
    <div className="av-code-block">
      {chrome && (
        <div className="av-code-head">
          <span className="av-code-lang">{lang || language}</span>
          <button
            className={`av-code-copy ${copied ? 'av-code-copied' : ''}`}
            title="Copy code"
            onClick={() => {
              void navigator.clipboard?.writeText(code);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <Editor
        value={code}
        language={language}
        theme={theme}
        beforeMount={defineOrchestraThemes}
        height={height}
        options={{
          ...MONACO_FONT,
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: 'off',
          folding: false,
          renderLineHighlight: 'none',
          scrollbar: { alwaysConsumeMouseWheel: false },
          overviewRulerLanes: 0,
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
