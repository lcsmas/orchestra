// Pure, JSX-free markdown block splitting + language mapping. Kept in a `.ts`
// module (no React/JSX) so it loads under the `node --test
// --experimental-strip-types` runner, which strips types but does NOT transform
// JSX. The JSX rendering that consumes these blocks lives in `markdown.tsx`.

/** A parsed markdown document: an ordered list of block nodes. The `html` block
 *  carries only the raw source text — `markdown.tsx` turns it into React nodes.
 *  Splitting fenced code out lets the message bubble drop a syntax-highlighted
 *  editor in its place. */
export type MdBlock =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'html'; text: string };

/**
 * Split a markdown string into ordered blocks: fenced code (```/~~~) vs
 * everything else. Tolerant of a still-streaming (unclosed) fence — the partial
 * body is captured as a code block rather than throwing. This is the hot path
 * (runs on every RAF flush while text streams), so it's a single linear scan.
 */
export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.split('\n');
  let i = 0;
  let htmlBuf: string[] = [];

  const flushHtml = () => {
    const text = htmlBuf.join('\n');
    htmlBuf = [];
    // Skip a buffer that is entirely blank — empty/whitespace-only input (and the
    // trailing empty line after a fence) shouldn't produce a spurious block.
    if (text.trim() === '') return;
    blocks.push({ kind: 'html', text });
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flushHtml();
      const marker = fence[1][0];
      const lang = fence[2].trim().split(/\s+/)[0] ?? '';
      const body: string[] = [];
      i++;
      // Consume until the closing fence (or EOF — a still-streaming block).
      while (i < lines.length) {
        const closing = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (closing && closing[1][0] === marker) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ kind: 'code', lang, text: body.join('\n') });
      continue;
    }
    htmlBuf.push(line);
    i++;
  }
  flushHtml();
  return blocks;
}

/** Map a fenced-code language hint (or file extension) to a Monaco language id. */
export function monacoLang(hint: string): string {
  const h = hint.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    typescript: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    javascript: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    python: 'python',
    go: 'go',
    rs: 'rust',
    rust: 'rust',
    java: 'java',
    rb: 'ruby',
    ruby: 'ruby',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    shell: 'shell',
    zsh: 'shell',
    sql: 'sql',
    toml: 'ini',
    ini: 'ini',
    c: 'c',
    cpp: 'cpp',
    'c++': 'cpp',
    diff: 'diff',
  };
  return map[h] ?? 'plaintext';
}

/** Language id from a file path's extension (for Edit/Write diffs). */
export function langFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return monacoLang(ext);
}
