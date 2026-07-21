// Readable rendering of a tool's requested input, shared by the permission
// dialog (and reusable by tool cards). A permission prompt must show the user
// exactly what they are approving — the Bash command, the file path + a preview
// of what would be written, the target of a Read/Grep — not a raw JSON blob.
//
// Structural only: classes are `av-*` so A5's agent-view.css styles them. Kept
// dependency-free (no markdown/highlighter) so it is safe on the permission
// path, which must be reliable.

import type { ReactNode } from 'react';

/** Truncate a long string for a preview, keeping it readable. */
function clip(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} more characters)`;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** A labelled field row inside a tool-input rendering. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="av-tool-field">
      <span className="av-tool-field-label">{label}</span>
      <div className="av-tool-field-value">{children}</div>
    </div>
  );
}

/** A monospace, pre-formatted code/output block. */
function Code({ text }: { text: string }) {
  return <pre className="av-tool-code">{text}</pre>;
}

/**
 * Render a tool's input in a human-readable, tool-aware way. Falls back to
 * pretty JSON for tools without a bespoke renderer.
 */
export function ToolInput({
  name,
  input,
}: {
  name: string;
  input: Record<string, unknown>;
}) {
  switch (name) {
    case 'Bash': {
      const command = asString(input.command);
      const description = asString(input.description);
      return (
        <div className="av-tool-input av-tool-input-bash">
          {description && <p className="av-tool-desc">{description}</p>}
          <Code text={command} />
        </div>
      );
    }
    case 'Write': {
      const filePath = asString(input.file_path);
      const content = asString(input.content);
      return (
        <div className="av-tool-input av-tool-input-write">
          <Field label="Write file">
            <code className="av-tool-path">{filePath}</code>
          </Field>
          <Field label="Contents">
            <Code text={clip(content)} />
          </Field>
        </div>
      );
    }
    case 'Edit':
    case 'MultiEdit': {
      const filePath = asString(input.file_path);
      const oldStr = asString(input.old_string);
      const newStr = asString(input.new_string);
      return (
        <div className="av-tool-input av-tool-input-edit">
          <Field label="Edit file">
            <code className="av-tool-path">{filePath}</code>
          </Field>
          {(oldStr || newStr) && (
            <div className="av-tool-editdiff">
              <div className="av-tool-editdiff-side av-tool-editdiff-old">
                <span className="av-tool-field-label">Replace</span>
                <Code text={clip(oldStr)} />
              </div>
              <div className="av-tool-editdiff-side av-tool-editdiff-new">
                <span className="av-tool-field-label">With</span>
                <Code text={clip(newStr)} />
              </div>
            </div>
          )}
        </div>
      );
    }
    case 'Read':
    case 'Glob':
    case 'Grep': {
      const path = asString(input.file_path ?? input.path);
      const pattern = asString(input.pattern);
      return (
        <div className="av-tool-input av-tool-input-read">
          {pattern && (
            <Field label="Pattern">
              <code className="av-tool-path">{pattern}</code>
            </Field>
          )}
          {path && (
            <Field label={name === 'Read' ? 'File' : 'Path'}>
              <code className="av-tool-path">{path}</code>
            </Field>
          )}
        </div>
      );
    }
    default: {
      // Unknown tool: pretty-print the whole input so the user still sees
      // exactly what is being approved.
      return (
        <div className="av-tool-input av-tool-input-generic">
          <Code text={clip(asString(input))} />
        </div>
      );
    }
  }
}
