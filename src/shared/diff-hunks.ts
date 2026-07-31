/** Pure unified-diff model: parse `git diff` text into files/hunks/lines, and
 *  rebuild a valid patch for an arbitrary SUBSET of those hunks so it can be fed
 *  back to `git apply --cached`.
 *
 *  Why this lives in `src/shared/` with its own tests rather than inside the
 *  renderer component: rebuilding a patch is the one part of selective staging
 *  that can corrupt a working tree, and its two failure modes are NOT equally
 *  loud. Measured against real git (`git apply --cached`, git 2.x) while
 *  building this:
 *
 *  - HUNK LINE COUNTS are strictly validated. A header whose `,N` disagrees
 *    with the number of body lines is rejected outright — `error: corrupt patch
 *    at line N`, exit 128. This is why `renderHunk` derives both counts from the
 *    body via `countConsumed` instead of copying the parsed header: any future
 *    change that filters lines stays consistent by construction.
 *  - NEW-SIDE START OFFSETS are ignored by `git apply`. It locates each hunk by
 *    old-side context, so a deliberately absurd `+9999` still applies cleanly.
 *
 *  The `shift` arithmetic below therefore is NOT what makes `git apply` succeed
 *  (verified: an unshifted subset patch applies identically). It exists so the
 *  patch text we produce is *honest* — the header describes the file the patch
 *  actually produces. That matters for anything that reads the patch rather than
 *  applying it (`git apply --check`-style tooling, a user copying the text out,
 *  and stricter appliers such as `patch(1)` and some review tools, which do use
 *  the new-side offset). Cheap to get right, so we get it right.
 *
 *  The invariant: when you stage hunks 1 and 3 but not hunk 2, hunk 3's NEW-side
 *  start must be shifted back by the net line delta of every SKIPPED earlier
 *  hunk, because the blob being patched lacks hunk 2's changes. */

/** One line inside a hunk. `context` lines exist on both sides. */
export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  /** Text WITHOUT the leading +/-/space marker. */
  text: string;
  /** 1-based line number on the old (pre-image) side; null for additions. */
  oldLine: number | null;
  /** 1-based line number on the new (post-image) side; null for deletions. */
  newLine: number | null;
}

export interface DiffHunk {
  /** Stable id, unique within its file: `${fileIndex}:${hunkIndex}`-free —
   *  we use the header offsets so it survives a re-fetch that didn't change
   *  the file. */
  id: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Trailing text on the `@@` header line (git puts the enclosing function
   *  there). Rendered as a dim caption; not part of patch semantics. */
  heading: string;
  lines: DiffLine[];
  /** True when the hunk body ended with git's `\ No newline at end of file`
   *  marker. Preserved verbatim on rebuild — dropping it corrupts the blob. */
  noNewlineAtEof: boolean;
}

export interface DiffFilePatch {
  /** Post-image path (what the UI labels the file). */
  path: string;
  /** Pre-image path. Differs from `path` only for renames/copies. */
  oldPath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Everything between the `diff --git` line and the first `@@`, verbatim.
   *  Carries the mode/index/rename metadata git needs to apply the patch. */
  headerLines: string[];
  hunks: DiffHunk[];
  /** True for a binary file (git emits no hunks). Cannot be selectively
   *  staged — the UI stages it whole-file or not at all. */
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Strip one layer of `a/` `b/` prefix that `git diff` adds by default. */
function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Unquote a git path. Paths with unusual bytes are emitted C-quoted
 *  (`"src/caf\303\251.ts"`); leaving them quoted makes the path not match the
 *  file on disk. */
function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      const simple: Record<string, number> = {
        n: 10,
        t: 9,
        r: 13,
        '"': 34,
        '\\': 92,
      };
      bytes.push(simple[next] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Pull the two paths out of a `diff --git a/x b/y` line.
 *  Handles quoted paths and (for the unquoted case) paths containing spaces,
 *  which are ambiguous — we resolve them by finding the ` b/` split point. */
function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    // Quoted form: `"a/x" "b/y"` (git quotes BOTH sides when either needs it).
    const close = rest.indexOf('" ', 1);
    if (close === -1) return null;
    const a = rest.slice(0, close + 1);
    const b = rest.slice(close + 2);
    return {
      oldPath: stripPrefix(unquotePath(a)),
      newPath: stripPrefix(unquotePath(b)),
    };
  }
  // Unquoted. Split on the LAST ` b/` so `a/my file.txt b/my file.txt` works.
  const idx = rest.lastIndexOf(' b/');
  if (idx === -1) {
    const parts = rest.split(' ');
    if (parts.length < 2) return null;
    return { oldPath: stripPrefix(parts[0]), newPath: stripPrefix(parts[1]) };
  }
  return {
    oldPath: stripPrefix(rest.slice(0, idx)),
    newPath: stripPrefix(rest.slice(idx + 1)),
  };
}

/**
 * Parse raw `git diff` output (any number of files) into the model above.
 *
 * Tolerant by design: unknown metadata lines inside a file header are kept
 * verbatim in `headerLines` so a rebuilt patch stays byte-faithful, and a
 * malformed `@@` line ends the current file's hunks rather than throwing —
 * a diff we can't fully parse should degrade to "not selectable", never crash
 * the pane.
 */
export function parseUnifiedDiff(raw: string): DiffFilePatch[] {
  if (!raw) return [];
  const lines = raw.split('\n');
  const files: DiffFilePatch[] = [];
  let file: DiffFilePatch | null = null;
  let hunk: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  const closeHunk = () => {
    if (file && hunk) file.hunks.push(hunk);
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      closeHunk();
      const paths = parseDiffGitLine(line);
      file = {
        path: paths?.newPath ?? '',
        oldPath: paths?.oldPath ?? '',
        status: 'modified',
        headerLines: [line],
        hunks: [],
        binary: false,
      };
      files.push(file);
      continue;
    }
    if (!file) continue;

    if (hunk === null) {
      // Still in the file header.
      const m = HUNK_RE.exec(line);
      if (m) {
        oldCursor = Number(m[1]);
        newCursor = Number(m[3]);
        hunk = {
          id: `${m[1]},${m[2] ?? '1'} ${m[3]},${m[4] ?? '1'}`,
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
          heading: m[5] ?? '',
          lines: [],
          noNewlineAtEof: false,
        };
        continue;
      }
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from') || line.startsWith('rename to'))
        file.status = 'renamed';
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch'))
        file.binary = true;
      file.headerLines.push(line);
      continue;
    }

    // Inside a hunk body.
    const marker = line[0];
    if (marker === '@') {
      const m = HUNK_RE.exec(line);
      if (m) {
        closeHunk();
        oldCursor = Number(m[1]);
        newCursor = Number(m[3]);
        hunk = {
          id: `${m[1]},${m[2] ?? '1'} ${m[3]},${m[4] ?? '1'}`,
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
          heading: m[5] ?? '',
          lines: [],
          noNewlineAtEof: false,
        };
        continue;
      }
      closeHunk();
      continue;
    }
    if (line.startsWith('\\')) {
      // `\ No newline at end of file` — belongs to the line just emitted.
      hunk.noNewlineAtEof = true;
      continue;
    }
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: line.slice(1), newLine: newCursor++, oldLine: null });
      continue;
    }
    if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldCursor++, newLine: null });
      continue;
    }
    if (marker === ' ' || line === '') {
      // A context line. Git writes a bare empty line for an empty context line
      // (the trailing space is often stripped in transit), so treat '' as
      // context — but only while we're inside a hunk that still expects lines.
      const consumed = countConsumed(hunk);
      if (line === '' && consumed.old >= hunk.oldCount && consumed.new >= hunk.newCount) {
        // The hunk is already full: this blank is the separator before the next
        // file, not a context line. Close out rather than corrupting counts.
        closeHunk();
        continue;
      }
      hunk.lines.push({
        kind: 'context',
        text: line.slice(1),
        oldLine: oldCursor++,
        newLine: newCursor++,
      });
      continue;
    }
    // Anything else (e.g. `diff --cc` conflict markers) ends the hunk.
    closeHunk();
  }
  closeHunk();
  return files;
}

function countConsumed(h: DiffHunk): { old: number; new: number } {
  let o = 0;
  let n = 0;
  for (const l of h.lines) {
    if (l.kind !== 'add') o++;
    if (l.kind !== 'del') n++;
  }
  return { old: o, new: n };
}

/** Additions/deletions for one hunk. */
export function hunkStats(h: DiffHunk): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of h.lines) {
    if (l.kind === 'add') additions++;
    else if (l.kind === 'del') deletions++;
  }
  return { additions, deletions };
}

/** Additions/deletions for a whole file. */
export function fileStats(f: DiffFilePatch): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of f.hunks) {
    const s = hunkStats(h);
    additions += s.additions;
    deletions += s.deletions;
  }
  return { additions, deletions };
}

/** Render one hunk back to patch text (header + body lines). `newStart` is
 *  passed in rather than read off the hunk because a subset rebuild shifts it. */
function renderHunk(h: DiffHunk, newStart: number): string[] {
  const consumed = countConsumed(h);
  const out: string[] = [];
  const oldRange = consumed.old === 1 ? `${h.oldStart}` : `${h.oldStart},${consumed.old}`;
  const newRange = consumed.new === 1 ? `${newStart}` : `${newStart},${consumed.new}`;
  // A zero-length side is written as `start,0` where start is the line BEFORE
  // the insertion point — git's own convention, and `git apply` depends on it.
  const oldSpec = consumed.old === 0 ? `${h.oldStart},0` : oldRange;
  const newSpec = consumed.new === 0 ? `${newStart},0` : newRange;
  out.push(`@@ -${oldSpec} +${newSpec} @@${h.heading ? ` ${h.heading}` : ''}`);
  for (const l of h.lines) {
    const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    out.push(`${marker}${l.text}`);
  }
  if (h.noNewlineAtEof) out.push('\\ No newline at end of file');
  return out;
}

/** A selection of hunks: file path → set of hunk ids. A file present with an
 *  EMPTY set contributes nothing (same as absent). */
export type HunkSelection = Map<string, Set<string>>;

/**
 * Rebuild a patch containing only the selected hunks, suitable for
 * `git apply --cached -`.
 *
 * Per file, hunks are emitted in their original order and each selected hunk's
 * NEW-side start is shifted by the accumulated net delta of every SKIPPED
 * earlier hunk in that file — because the index blob being patched lacks those
 * skipped changes. Old-side offsets are untouched (the pre-image is HEAD's
 * blob either way).
 *
 * Returns '' when nothing is selected, so callers can cheaply skip the git call.
 */
export function buildPatch(files: DiffFilePatch[], selection: HunkSelection): string {
  const out: string[] = [];
  for (const file of files) {
    const wanted = selection.get(file.path);
    if (!wanted || wanted.size === 0) continue;
    const selected = file.hunks.filter((h) => wanted.has(h.id));
    if (selected.length === 0) continue;

    out.push(...file.headerLines);
    // Net new-side shift caused by hunks we are NOT staging.
    let shift = 0;
    for (const h of file.hunks) {
      const consumed = countConsumed(h);
      if (!wanted.has(h.id)) {
        shift += consumed.new - consumed.old;
        continue;
      }
      out.push(...renderHunk(h, h.newStart - shift));
    }
  }
  if (out.length === 0) return '';
  return `${out.join('\n')}\n`;
}

/** Reverse a patch in place: swap +/- and old/new sides, so the same subset can
 *  be UNSTAGED with `git apply --cached --reverse`. Callers can equivalently
 *  pass `--reverse` to git; this exists for tests and for callers that need the
 *  literal reversed text. */
export function reversePatchFiles(files: DiffFilePatch[]): DiffFilePatch[] {
  return files.map((f) => ({
    ...f,
    hunks: f.hunks.map((h) => ({
      ...h,
      oldStart: h.newStart,
      oldCount: h.newCount,
      newStart: h.oldStart,
      newCount: h.oldCount,
      lines: h.lines.map((l) => ({
        kind: l.kind === 'add' ? ('del' as const) : l.kind === 'del' ? ('add' as const) : l.kind,
        text: l.text,
        oldLine: l.newLine,
        newLine: l.oldLine,
      })),
    })),
  }));
}

/** Every hunk id in a file — the "select all" helper the file checkbox uses. */
export function allHunkIds(f: DiffFilePatch): Set<string> {
  return new Set(f.hunks.map((h) => h.id));
}

/** Tri-state for a file-level checkbox given the current selection. */
export function fileCheckState(
  f: DiffFilePatch,
  selection: HunkSelection,
): 'none' | 'some' | 'all' {
  const wanted = selection.get(f.path);
  if (!wanted || wanted.size === 0) return 'none';
  const total = f.hunks.length;
  if (total === 0) return 'none';
  let hit = 0;
  for (const h of f.hunks) if (wanted.has(h.id)) hit++;
  if (hit === 0) return 'none';
  return hit === total ? 'all' : 'some';
}

/** Count of selected hunks across every file. Drives the Stage button label. */
export function countSelected(selection: HunkSelection): number {
  let n = 0;
  for (const set of selection.values()) n += set.size;
  return n;
}
