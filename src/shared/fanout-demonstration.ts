// #572 — `minorPolicy=demonstrated`: the DEMONSTRATION a finding may carry {input, observed, expected} and the rule that accepts it.
// Pure (no fs / git): the CLI hands in `fileOnHead`. Code checks a demonstration is WELL FORMED, never that it is TRUE — a wrong one costs one fix round or one coordinator decision.

/** Each of the three texts needs at least this many words (observed: not counting its file:line citations). Chosen so « POST /orders with qty 0 » (5) passes and a bare label (« wrong output », « crashes ») cannot. */
export const DEMONSTRATION_WORD_FLOOR = 5;
export const DEMONSTRATION_FIELDS = ['input', 'observed', 'expected'] as const;
export const DEMONSTRATION_TEXT_MAX = 2000;
const REFUSAL_MAX = 400;
const listed = (xs: string[]): string => (xs.length > 3 ? `${xs.slice(0, 3).join(', ')} (+${xs.length - 3} more)` : xs.join(', '));
/** The limit, stated where a recorder reads it (the `state` help, the skill). */
export const DEMONSTRATION_LIMIT = 'Limit: code checks the demonstration is well formed (3 fields of >= 5 words, different from each other, `observed` cites a PRODUCT file:line that exists on the reviewed head), not that it is true — a wrong one costs one fix round or one coordinator decision.';

/** What a finding stores. `file` + `head` = accepted (the CLI saw `file` on `head`); `refusal` = rejected, the reason (the finding stays a plain MINOR). Both absent = unchecked = NOT accepted. */
export interface Demonstration { input: string; observed: string; expected: string; file?: string; head?: string; refusal?: string }

/** Words = whitespace-separated tokens holding at least one letter or digit (punctuation alone is not a word). */
export const wordsOf = (text: string): number => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const normalised = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** A citation `path/to/file.ext:12` (or `:12-30`): the path has an extension, no `..`, not absolute; the line is mandatory — « observed (file:line) ». Unicode letters / digits and balanced `(group)` / `[id]` segments (Next.js app router) are path characters; a SPACE is not (a path with spaces is not citable). */
const SEG = String.raw`(?:[\p{L}\p{N}_@+~$.-]|\([^()\s/]*\)|\[[^\[\]\s/]*\])+`;
const CITATION = new RegExp(String.raw`(?<![\p{L}\p{N}_@./+~$-])((?:\.\/)?(?:${SEG}\/)*${SEG}\.[A-Za-z][A-Za-z0-9]{0,9}):(\d+)(?:-\d+)?`, 'gu');
export function citationsOf(observed: string): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  const text = observed.replace(/\\/g, '/'); // `src\a.ts:4` is src/a.ts, never the root file a.ts
  for (const m of text.matchAll(CITATION)) {
    const p = m[1].replace(/^\.\//, '');
    if (p.split('/').includes('..') || out.some((c) => c.path === p)) continue;
    // `src/my a.ts:1` would read as the ROOT file `a.ts`: a slash-less citation right after a slash-bearing word that is not itself a citation / punctuated is a path broken by a space — never looked up
    if (!p.includes('/')) {
      const prev = /(\S+)\s+$/.exec(text.slice(0, m.index))?.[1];
      if (prev && prev.includes('/') && !/(?::\d+(?:-\d+)?|[,;.!?)])$/.test(prev)) continue;
    }
    out.push({ path: p, line: Number(m[2]) });
  }
  return out;
}
const stripCitations = (observed: string): string => observed.replace(/\\/g, '/').replace(CITATION, ' ');

// ── product / test / docs: the ONE classification (no other module of the repo classifies a path: fanout-harness only finds integration specs) ──
const TEST_DIR = /^(?:tests?|__tests?__|__mocks__|__fixtures__|__snapshots__|specs?|e2e|e2e-tests?|tests?-e2e|integration-tests?|fixtures?|testdata|test[-_]?(?:utils?|helpers?|support)|mocks?|cypress|playwright|pause-canary)$/i;
/** `a.test.ts`, `app.e2e-spec.ts`, `x.stories.tsx`, `y.snap` (a dot-segment of the basename) · `test_x.py`, `x_test.go`, `x_spec.rb`, `conftest.py`, `e2e-run.mjs` · `FooTest.java`, `FooTests.cs` (case-sensitive: `Latest.ts` is product). */
const TEST_FILE_CI = /(?:\.(?:tests?|spec|e2e|e2e-spec|int-spec|integration|stories|snap|test-d|testlib|mocks?|fixtures?)(?:\.|$)|^test[_-]|[_-](?:test|spec)\.[^.]+$|^conftest\.py$|(?:^|[._-])e2e(?:[._-]|$)|[._-]rig\.[^.]+$)/i;
const TEST_FILE_CS = /[a-z0-9]Tests?\.[A-Za-z]+$/;
const DOC_DIR = /^(?:docs?|documentation)$/i;
const DOC_FILE = /(?:^(?!cmakelists\.txt$|requirements[^/]*\.txt$)[^/]*\.(?:md|mdx|markdown|rst|adoc|txt|org)$|^(?:readme|changelog|license|licence|notice|authors|contributing|codeowners)(?:\.(?:md|mdx|rst|adoc|txt))?$)/i;
const NOT_SOURCE_DIR = /^(?:node_modules|dist|build|out|coverage|vendor|\.git|\.next|target)$/i;
export type PathClass = 'product' | 'test' | 'docs' | 'vendored';
export function classifyPath(p: string): PathClass {
  const segs = p.replace(/^\.\//, '').split('/').filter(Boolean);
  const base = segs[segs.length - 1] ?? '';
  if (segs.slice(0, -1).some((s) => NOT_SOURCE_DIR.test(s))) return 'vendored';
  if (segs.slice(0, -1).some((s) => TEST_DIR.test(s)) || TEST_FILE_CI.test(base) || TEST_FILE_CS.test(base)) return 'test';
  if (segs.slice(0, -1).some((s) => DOC_DIR.test(s)) || DOC_FILE.test(base)) return 'docs';
  return 'product';
}
export const isProductPath = (p: string): boolean => classifyPath(p) === 'product';

/** Why the three TEXTS are not a demonstration (null = fine) — the part code can re-check anywhere, with no git. */
export function textRefusal(d: Pick<Demonstration, 'input' | 'observed' | 'expected'>): string | null {
  for (const k of DEMONSTRATION_FIELDS) if (typeof d[k] !== 'string' || !d[k].trim()) return `${k} is blank or missing`;
  for (const k of DEMONSTRATION_FIELDS) {
    const n = wordsOf(k === 'observed' ? stripCitations(d[k]) : d[k]);
    if (n < DEMONSTRATION_WORD_FLOOR) return `${k} has ${n} word(s)${k === 'observed' ? ' besides its file:line' : ''}, the floor is ${DEMONSTRATION_WORD_FLOOR}`;
  }
  for (const [a, b] of [['input', 'observed'], ['input', 'expected'], ['observed', 'expected']] as const) if (normalised(d[a]) === normalised(d[b])) return `${a} and ${b} are the same text`;
  return null;
}

/** Existence of `path` on `head`: true | false | null (unreadable here — head not fetched, no gh). */
export type FileOnHead = (head: string, path: string) => boolean | null;

/** Classify a raw demonstration: the stored form — accepted (`file` + `head`) or refused (`refusal`). Never throws on content. */
export function classifyDemonstration(raw: Pick<Demonstration, 'input' | 'observed' | 'expected'>, ctx: { head: string | null; fileOnHead?: FileOnHead }): Demonstration {
  const base = { input: raw.input ?? '', observed: raw.observed ?? '', expected: raw.expected ?? '' };
  const refuse = (why: string): Demonstration => ({ ...base, refusal: why.length > REFUSAL_MAX ? `${why.slice(0, REFUSAL_MAX - 1)}…` : why }); // the reason is stored (≤ 500 chars): a long list of cited paths must not make the record unstorable
  const t = textRefusal(base);
  if (t) return refuse(t);
  const cites = citationsOf(base.observed);
  if (cites.length === 0) return refuse('observed names no file:line (write the product file and line it reads, e.g. src/orders/service.ts:42)');
  const product = cites.filter((c) => isProductPath(c.path));
  if (product.length === 0) return refuse(`observed cites only ${listed(cites.map((c) => `${c.path} (${classifyPath(c.path)})`))} — a demonstration needs a PRODUCT file (not a test / spec, not documentation)`);
  if (!ctx.head) return refuse('the ticket has no recorded head (--head) to read the cited file on');
  if (!ctx.fileOnHead) return refuse(`cannot read ${product[0].path} on ${ctx.head.slice(0, 8)} here (no git)`);
  let unreadable = false;
  for (const c of product) {
    const here = ctx.fileOnHead(ctx.head, c.path);
    if (here === true) return { ...base, file: c.path, head: ctx.head };
    if (here === null) unreadable = true;
  }
  return refuse(unreadable ? `cannot read ${listed(product.map((c) => c.path))} on head ${ctx.head.slice(0, 8)} (not fetched?) — fetch it and record the finding again` : `${listed(product.map((c) => c.path))} does not exist on head ${ctx.head.slice(0, 8)}`);
}

/** Is this stored demonstration ACCEPTED: no refusal, the three texts still pass (a hand-edited state cannot smuggle a blank / short / identical one), and the file the CLI saw on a head is a product file the observed text cites. */
export function demonstrationAccepted(d: Demonstration | undefined): boolean {
  if (!d || d.refusal !== undefined || !d.file || !d.head) return false;
  return textRefusal(d) === null && isProductPath(d.file) && citationsOf(d.observed).some((c) => c.path === d.file);
}
