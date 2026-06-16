import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { DiffFile } from '../../shared/types';

interface Props {
  workspaceId: string;
}

export function DiffView({ workspaceId }: Props) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const diffs = await window.orchestra.getDiff(workspaceId);
        if (!alive) return;
        setFiles(diffs);
        // Preserve the user's current selection across polling refreshes;
        // only fall back to the first file when nothing is selected or the
        // selected file no longer appears in the diff.
        setActive((prev) =>
          prev && diffs.some((f) => f.path === prev) ? prev : diffs[0]?.path ?? null
        );
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [workspaceId]);

  const activeFile = files.find((f) => f.path === active);

  if (loading && files.length === 0) {
    return <div className="empty">Loading diff…</div>;
  }
  if (files.length === 0) {
    return <div className="empty"><h2>No changes yet</h2><div>The agent hasn't modified any files in this worktree.</div></div>;
  }

  return (
    <div className="diff-pane">
      <div className="diff-files">
        {files.map((f) => (
          <div
            key={f.path}
            className={`diff-file-item ${active === f.path ? 'active' : ''}`}
            onClick={() => setActive(f.path)}
          >
            <span className="diff-file-name" title={f.path}>{f.path}</span>
            <span className="diff-stat">
              <span className="add">+{f.additions}</span>{' '}
              <span className="del">-{f.deletions}</span>
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {activeFile && (
          <>
            <div className="diff-header">
              <span className="path">{activeFile.path}</span>
              <span className="diff-stat">
                <span className="add">+{activeFile.additions}</span>{' '}
                <span className="del">-{activeFile.deletions}</span>
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <DiffEditor
                original={activeFile.oldContent}
                modified={activeFile.newContent}
                language={guessLanguage(activeFile.path)}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                }}
                height="100%"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function guessLanguage(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const m: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', py: 'python', go: 'go', rs: 'rust',
    java: 'java', rb: 'ruby', css: 'css', scss: 'scss', html: 'html',
    yml: 'yaml', yaml: 'yaml', sh: 'shell', sql: 'sql', toml: 'toml',
  };
  return m[ext] ?? 'plaintext';
}
