import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeMdImports } from '../shared/claude-md-imports.ts';
import { oversizedMemoryFiles, type MemoryFileSize, type OversizedMemoryFile } from '../shared/memory-size.ts';

/**
 * Measure the CLAUDE.md memory files a session loaded, so the structured view
 * can show the oversized-memory warning the CLI prints in its startup banner
 * but never sends over the wire (see `src/shared/memory-size.ts` for why this
 * is a replica rather than a subscription).
 *
 * The CLI measures a memory entry's content AFTER `@import` expansion, so a
 * modest CLAUDE.md that imports a huge LESSONS.md is reported at the combined
 * size. We reproduce that by inlining single-segment imports the same way
 * {@link parseClaudeMdImports} defines them.
 */

/** Cap on import recursion — a cycle (`a.md` imports `b.md` imports `a.md`)
 *  must not hang the main process. */
const MAX_IMPORT_DEPTH = 5;

/** Resolved size of one memory file, with its imports inlined. Returns null if
 *  the file cannot be read (deleted between init and here, permissions, …) —
 *  an unreadable memory file is not a warning, it is simply unmeasurable. */
function resolvedSize(file: string, seen: Set<string>, depth: number): number | null {
  const abs = path.resolve(file);
  // A file already counted in this chain contributes nothing further; this is
  // what makes an import cycle terminate rather than recurse forever.
  if (seen.has(abs)) return 0;
  seen.add(abs);

  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }

  let total = content.length;
  if (depth < MAX_IMPORT_DEPTH) {
    const dir = path.dirname(abs);
    for (const name of parseClaudeMdImports(content)) {
      // Imports resolve relative to the importing file's own directory.
      total += resolvedSize(path.join(dir, name), seen, depth + 1) ?? 0;
    }
  }
  return total;
}

/** Measure each memory path (imports inlined). Unreadable paths are dropped. */
export function measureMemoryFiles(paths: readonly string[]): MemoryFileSize[] {
  const out: MemoryFileSize[] = [];
  for (const p of paths) {
    // A fresh `seen` per top-level file: two memory files legitimately import
    // the same shared LESSONS.md, and each is measured as the CLI reports it.
    const chars = resolvedSize(p, new Set(), 0);
    if (chars !== null) out.push({ path: p, chars });
  }
  return out;
}

/**
 * The memory files over the limit for a session, ready to render. `contextWindow`
 * is the model's window in tokens when known — the SDK only reports it on
 * `result` messages, so the first turn uses the CLI's own 200k fallback.
 */
export function findOversizedMemoryFiles(
  paths: readonly string[],
  contextWindowTokens?: number | null,
): OversizedMemoryFile[] {
  if (!paths.length) return [];
  return oversizedMemoryFiles(measureMemoryFiles(paths), contextWindowTokens);
}
