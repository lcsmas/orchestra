// Pure helper (no electron imports) so it stays testable under `node --test`.

/** Single-segment `@file` imports referenced from a CLAUDE.md body (e.g.
 *  `@RTK.md`, `@LESSONS.md`). Claude Code resolves these relative to the file's
 *  own location — so when CLAUDE.md is symlinked into a login dir, every
 *  imported file needs its own symlink there too or the import silently breaks.
 *  Only bare filenames count: imports with path separators point outside the
 *  config dir and are not ours to materialize. */
export function parseClaudeMdImports(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const m = /^@([\w][\w.-]*)$/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}
