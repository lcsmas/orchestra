// #540 — the PURE assertion extractor + comparator behind `fanout acceptance amend --harness-only`: a frozen test file may change setup / teardown / context only, so the "contract
// statements" of the old and the new bytes must be IDENTICAL, in order: (A) assertion statements (+ the control prefix on their line and the non-test blocks that enclose them), (D) test
// declaration heads (title, options, callback parameters), (B) bindings / imports of the test runner and assert identifiers, (C) return / throw / break / continue inside a test body, and
// skip / exit neutralisers. Families: JS/TS (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`) and Python (`.py`). Anything else, an unlexable file, no assertion, or an assertion-shaped call it
// cannot read = unknown shape ⇒ `ok:false` (FAIL CLOSED: the change needs the full decision amend).
// NOT proven (residue, disclosed in help + acceptance-tests.md): a VALUE an assertion references but a setup line defines (`const expected = 2`, `run = async () => 5`), what a helper the
// test calls does, and runner CONFIG files. The amend prints + records the changed non-assertion lines so the coordinator can attest them.
import crypto from 'node:crypto';

export type AssertionFamily = 'js' | 'python';
export type Extracted = { ok: true; family: AssertionFamily; statements: string[] } | { ok: false; why: string };
export type Compared = { ok: true } | { ok: false; kind: 'unknown-shape' | 'added' | 'removed' | 'reordered' | 'modified'; why: string };

export function familyOf(path: string): AssertionFamily | null {
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return 'js';
  if (/\.py$/.test(path)) return 'python';
  return null;
}

// ── lexing: class per char (0 = code, 1 = string/regex/template text, 2 = comment) ─────────────────────────

const REGEX_PREV = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KW = /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|await|yield)$/;

/** JS/TS: classify every char. null = not lexable (unterminated string / comment / template / regex). */
function lexJs(src: string): Uint8Array | null {
  const cls = new Uint8Array(src.length);
  const n = src.length;
  const stack: number[] = []; // brace depth of each open `${`
  let braces = 0;
  let prevSig = -1; // index of the last significant code char / closing delimiter (regex vs division)
  const regexAllowed = (): boolean => {
    if (prevSig < 0) return true;
    const c = src[prevSig];
    if (REGEX_PREV.has(c)) return true;
    if (/[\w$]/.test(c)) return REGEX_KW.test(src.slice(Math.max(0, prevSig - 12), prevSig + 1));
    return false; // `)` `]` a literal's closing delimiter: division
  };
  // template text from `from` (just after the opening backtick or a `}` closing a `${`); returns the resume index, null when unterminated
  const readTemplate = (from: number): number | null => {
    let k = from;
    while (k < n) {
      const c = src[k];
      cls[k] = 1;
      if (c === '\\') { if (k + 1 < n) cls[k + 1] = 1; k += 2; continue; }
      if (c === '`') { prevSig = k; return k + 1; }
      if (c === '$' && src[k + 1] === '{') { cls[k + 1] = 1; stack.push(braces); braces++; prevSig = -1; return k + 2; }
      k++;
    }
    return null;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') cls[i++] = 2; continue; }
    if (c === '<' && src.startsWith('<!--', i)) { while (i < n && src[i] !== '\n') cls[i++] = 2; continue; } // an HTML-style line comment in a script
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) return null;
      for (let k = i; k < e + 2; k++) cls[k] = src[k] === '\n' ? 0 : 2;
      i = e + 2; continue;
    }
    if (c === '"' || c === "'") {
      cls[i] = 1;
      let k = i + 1;
      while (k < n && src[k] !== c) {
        if (src[k] === '\n') return null;
        if (src[k] === '\\') { cls[k] = 1; k++; }
        cls[k] = 1; k++;
      }
      if (k >= n) return null;
      cls[k] = 1; prevSig = k; i = k + 1; continue;
    }
    if (c === '`') {
      cls[i] = 1;
      const r = readTemplate(i + 1);
      if (r === null) return null;
      i = r; continue;
    }
    if (c === '/' && regexAllowed()) {
      cls[i] = 1;
      let k = i + 1;
      let inClass = false;
      let closed = false;
      while (k < n) {
        const d = src[k];
        if (d === '\n') return null;
        cls[k] = 1;
        if (d === '\\') { k++; if (k < n) cls[k] = 1; k++; continue; }
        if (d === '[') inClass = true; else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
        k++;
      }
      if (!closed) return null;
      k++;
      while (k < n && /[a-z]/i.test(src[k])) cls[k++] = 1;
      prevSig = k - 1; i = k; continue;
    }
    if (c === '{') braces++;
    if (c === '}') {
      braces--;
      if (stack.length && stack[stack.length - 1] === braces) { // closes a `${`: back to the template text
        stack.pop();
        cls[i] = 1;
        const r = readTemplate(i + 1);
        if (r === null) return null;
        i = r; continue;
      }
    }
    if (!/\s/.test(c)) prevSig = i;
    i++;
  }
  return stack.length ? null : cls;
}

/** Python: classify every char (strings incl. triple-quoted + prefixes, `#` comments). null = unterminated. */
function lexPy(src: string): Uint8Array | null {
  const cls = new Uint8Array(src.length);
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') { while (i < n && src[i] !== '\n') cls[i++] = 2; continue; }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      const rawish = i > 0 && /[rR]/.test(src[i - 1]) && (i < 2 || !/[\w]/.test(src[i - 2]) || /[bBfFuU]/.test(src[i - 2]));
      cls[i] = 1;
      let k = i + q.length;
      for (let m = i; m < k; m++) cls[m] = 1;
      let closed = false;
      while (k < n) {
        if (src[k] === '\\' && !rawish) { cls[k] = 1; if (k + 1 < n) cls[k + 1] = 1; k += 2; continue; }
        if (src[k] === '\\' && rawish) { cls[k] = 1; if (k + 1 < n) cls[k + 1] = 1; k += 2; continue; } // a raw string still cannot end on \"
        if (src.startsWith(q, k)) { for (let m = k; m < k + q.length; m++) cls[m] = 1; k += q.length; closed = true; break; }
        if (!triple && src[k] === '\n') return null;
        cls[k] = 1; k++;
      }
      if (!closed) return null;
      i = k; continue;
    }
    i++;
  }
  return cls;
}

// ── statement scanning ─────────────────────────────────────────────────────────────────────────────────────

const OPEN = new Set([...'([{']);
const CLOSE = new Set([...')]}']);

/** The text of src[a,b): comments become one space, every CODE line is trimmed (empty ones dropped) — but newlines and spaces INSIDE a string / template / regex are byte-exact. */
function normalise(src: string, cls: Uint8Array, a: number, b: number): string {
  const ch: string[] = [];
  const cc: number[] = [];
  let inComment = false;
  for (let k = a; k < b; k++) {
    if (cls[k] === 2) { if (!inComment) { ch.push(' '); cc.push(0); } inComment = true; continue; }
    inComment = false;
    if (src[k] === '\r' && cls[k] === 0) continue;
    ch.push(src[k]); cc.push(cls[k]);
  }
  const lines: string[] = [];
  let from = 0;
  const flush = (to: number): void => {
    let x = from;
    let y = to;
    while (x < y && cc[x] === 0 && /\s/.test(ch[x])) x++;
    while (y > x && cc[y - 1] === 0 && /\s/.test(ch[y - 1])) y--;
    if (y > x) lines.push(ch.slice(x, y).join(''));
  };
  for (let k = 0; k < ch.length; k++) if (ch[k] === '\n' && cc[k] === 0) { flush(k); from = k + 1; }
  flush(ch.length);
  return lines.join('\n');
}

/** src[a,b) with comments dropped, trailing whitespace trimmed, blank lines dropped; INDENTATION kept (a Python block). */
function blockText(src: string, cls: Uint8Array, a: number, b: number): string {
  let out = '';
  for (let k = a; k < b; k++) { if (cls[k] === 2) continue; out += src[k]; }
  return out.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '').join('\n');
}

/** An assertion-SHAPED call (assert* / expect* / verify*, any receiver) outside every extracted statement: the extractor does not read it, so the file's shape is unknown (fail closed). */
function unreadAssertion(src: string, cls: Uint8Array, ranges: Array<[number, number]>): string | null {
  const re = /(?:^|[^\w$])((?:assert\w*|expect\w*|verify\w*|\w*Assert\w*|\w*Expect\w*)(?:\.\w+)*\s*\()/gi;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const at = m.index + m[0].length - m[1].length;
    if (cls[at] !== 0 || ranges.some(([x, y]) => at >= x && at < y)) continue;
    if (/(?:def|function|class)\s+$/.test(src.slice(Math.max(0, at - 12), at))) continue; // a helper's DEFINITION (`def assert_close(`) is not a call
    if (!/^(?:assert\w*|expect\w*|verify\w*|\w*Assert\w*|\w*Expect\w*)/.test(src.slice(at, at + 60))) continue; // case-insensitive regex: keep the prefix rule exact
    return `${m[1].replace(/\s*\($/, '')}( at line ${src.slice(0, at).split('\n').length}`;
  }
  return null;
}

const JS_ASSERT_HEAD = new RegExp(
  '^(?:(?:await|return|void|yield)\\s+)*(?:' + [
    'expect(?:\\.\\w+)*\\s*[(.]', 'assert\\b(?:\\.\\w+)*\\s*[(.]', 'should\\b', 'chai\\.(?:expect|assert|should)\\b',
    't\\.assert\\b', 't\\.(?:is|not|true|false|truthy|falsy|deepEqual|notDeepEqual|like|throws|throwsAsync|notThrows|notThrowsAsync|regex|notRegex|snapshot|pass|fail|plan|skip|todo)\\s*\\(',
    '(?:assertEquals|assertNotEquals|assertStrictEquals|assertThrows|assertRejects|assertExists|assertMatch|assertNotMatch|assertArrayIncludes|assertObjectMatch|assertAlmostEquals|assertInstanceOf|assertFalse|assertStringIncludes|assertIsError|assertNotStrictEquals|assertSpyCalls|fail)\\s*\\(',
    '(?:strictEqual|deepStrictEqual|notStrictEqual|notDeepStrictEqual|deepEqual|notDeepEqual|throws|rejects|doesNotThrow|doesNotReject|ok|equal|notEqual|match|doesNotMatch|ifError)\\s*\\(',
    'expectTypeOf\\b', 'assertType\\b',
    '(?:process\\.(?:exit|abort|kill)|Deno\\.exit|Bun\\.exit)\\s*\\(', '(?:this|ctx|context)\\.(?:skip|todo)\\s*\\(', 'process\\.on\\s*\\(',
  ].join('|') + ')');
const JS_DECL_HEAD = /^(?:[xf]?(?:test|it|describe|suite|context|specify|bench)|t\.(?:test|describe|it|suite))(?:\.(?:skip|only|todo|each|concurrent|sequential|fails|failing|serial|parallel|runIf|skipIf|if|fixme|slow|retry))*\s*\(/;

/** The exclusive end of the statement (assertion: balanced to `;` / a newline not followed by `.` / the enclosing close) or declaration head (to the end of the title argument) starting at `start`; -1 = unbalanced. */
function endOfJs(src: string, cls: Uint8Array, start: number, decl: boolean): number {
  const n = src.length;
  let depth = 0;
  for (let k = start; k < n; k++) {
    if (cls[k] !== 0) continue;
    const ch = src[k];
    if (OPEN.has(ch)) { depth++; continue; }
    if (CLOSE.has(ch)) {
      depth--;
      if (depth < 0) return k;
      if (decl && depth === 0) { let m = k + 1; while (m < n && /[ \t]/.test(src[m])) m++; if (src[m] !== '(' && src[m] !== '.') return k + 1; }
      continue;
    }
    if (depth === 0 && (ch === ';' || ch === ',')) return k;
    if (decl && ch === ',' && depth === 1) return k;
    if (depth === 0 && ch === '\n') {
      let m = k + 1;
      while (m < n && (/\s/.test(src[m]) || cls[m] === 2)) m++;
      if (!(m < n && cls[m] === 0 && (src[m] === '.' || (src[m] === '?' && src[m + 1] === '.')))) return k;
    }
  }
  return depth === 0 ? n : -1;
}

const RUNNER_NAMES = 'test|it|describe|suite|context|specify|bench|assert|expect|should|before|after|beforeEach|afterEach|beforeAll|afterAll|chai|sinon|vi|jest|mocha';
const RUNNER_NAME_RE = new RegExp(`(?:^|[^\\w$.])(?:${RUNNER_NAMES})(?![\\w$])`);
const RUNNER_MODULE_RE = /(['"`])(?:node:test|node:assert(?:\/strict)?|assert(?:\/strict)?|chai|vitest|jest|@jest\/globals|mocha|ava|bun:test|supertest|sinon|expect|@std\/[\w/-]+|https?:\/\/deno\.land\/std[^'"`]*)\1/;
/** A definition NAME that is itself an assertion (`assertEqual`, `assert_close`, `expectOk`, `verifyAll`, `expect`) — but not `expected` / `assertion`-like locals. Its full text is pinned (gutting a helper must not pass). */
const DEF_NAME = '(?:assert|expect|verify)(?:[A-Z_$][\\w$]*)?';
const DEF_NAME_RE = new RegExp(`^${DEF_NAME}$`);
const DEF_TOKEN_RE = new RegExp(`(?:^|[^\\w$.])${DEF_NAME}(?![\\w$])`);
const SHAPED_RE = /(?:^|[^\w$])(?:assert\w*|expect\w*|verify\w*|\w*Assert\w*|\w*Expect\w*)(?:\.\w+)*\s*\(/;
const TEST_CB_RE = /(?:^|[\s;(,])(?:[xf]?(?:test|it|specify|bench)|t\.(?:test|it))(?:\.\w+)*\s*\(/;
const DECL_CB_RE = /(?:^|[\s;(,])(?:[xf]?(?:test|it|describe|suite|context|specify|bench)|t\.(?:test|describe|it|suite))(?:\.\w+)*\s*\(/;

/** An import / const / let / var that brings in or (re)binds a test-runner / assert identifier or module: pinned (`const test = () => {}`, `import assert from './fake.js'`). */
function pinnedBinding(raw: string): boolean {
  const m = /^(?:export\s+)?(import|const|let|var)\b/.exec(raw);
  if (!m) return false;
  if (m[1] === 'import') { const f = raw.search(/\bfrom\b/); return RUNNER_MODULE_RE.test(raw) || RUNNER_NAME_RE.test(f >= 0 ? raw.slice(m[0].length, f) : ''); }
  const eq = raw.search(/=(?![=>])/);
  const names = ` ${eq >= 0 ? raw.slice(m[0].length, eq) : raw.slice(m[0].length)}`;
  return RUNNER_NAME_RE.test(names) || DEF_TOKEN_RE.test(names) || (/\brequire\s*\(/.test(raw) && RUNNER_MODULE_RE.test(raw));
}

/** Headers (outermost → innermost) of the `{` blocks enclosing position `i`. */
function enclosingJs(src: string, cls: Uint8Array, i: number): string[] {
  const heads: string[] = [];
  let depth = 0;
  for (let k = i - 1; k >= 0; k--) {
    if (cls[k] !== 0) continue;
    if (src[k] === '}') depth++;
    else if (src[k] === '{') {
      if (depth > 0) { depth--; continue; }
      let j = k - 1;
      while (j >= 0 && !(cls[j] === 0 && (src[j] === ';' || src[j] === '{' || src[j] === '}'))) j--;
      heads.push(normalise(src, cls, Math.max(j + 1, k - 300), k));
    }
  }
  return heads.reverse();
}

/** The control context of a statement: the non-declaration blocks inside its nearest declaration callback, and whether it sits in a TEST body. */
function contextJs(src: string, cls: Uint8Array, i: number): { chain: string; inTest: boolean } {
  const heads = enclosingJs(src, cls, i);
  let last = -1;
  heads.forEach((h, n) => { if (DECL_CB_RE.test(h)) last = n; });
  return { chain: heads.slice(last + 1).join(' > '), inTest: heads.some((h) => TEST_CB_RE.test(h)) };
}

/** What controls the statement from the SAME line before it (`if (false)`, `0 &&`, `cond ?`, `setTimeout(() =>`) and from a controlling line above (`if (x)` / `else` / a trailing operator). */
function prefixJs(src: string, cls: Uint8Array, i: number): string {
  const ls = src.lastIndexOf('\n', i - 1) + 1;
  let from = ls;
  for (let k = i - 1; k >= ls; k--) if (cls[k] === 0 && (src[k] === ';' || src[k] === '{' || src[k] === '}')) { from = k + 1; break; }
  let pre = normalise(src, cls, from, i);
  if (pre && DECL_CB_RE.test(pre)) { const at = pre.lastIndexOf('=>'); pre = at >= 0 ? pre.slice(at + 2).trim() : ''; } // a one-line test: the declaration head is pinned as D, not part of the prefix
  if (!pre) {
    let e = ls - 1; // end of the previous line
    while (e > 0 && /\s/.test(src[e - 1])) e--;
    const ps = src.lastIndexOf('\n', e - 1) + 1;
    const prev = normalise(src, cls, ps, e);
    if (/(?:^|[;{}\s])(?:if|else|for|while|with|do)\b[^;{}]*$/.test(prev) || /(?:&&|\|\||\?|=>)$/.test(prev) || /\belse$/.test(prev)) pre = prev;
  }
  return pre;
}

/** Is position `i` the first token of a statement (after `;` `{` `}` or an ASI line break)? */
function stmtStart(src: string, cls: Uint8Array, i: number): boolean {
  let k = i - 1;
  let nl = false;
  while (k >= 0 && (cls[k] === 2 || /\s/.test(src[k]))) { if (src[k] === '\n') nl = true; k--; }
  if (k < 0) return true;
  if (cls[k] === 0 && (src[k] === ';' || src[k] === '{' || src[k] === '}')) return true;
  return nl && !(cls[k] === 0 && /[([,=:?+\-*/&|.!<>%^~]/.test(src[k]));
}

/** The options / trailing arguments of a declaration call (`test('a', { skip: true }, fn)`, `it('a', fn, 0)`) and the callback's PARAMETER list: everything after the title except the callback body. `at` = the title-ending comma. */
function declExtras(src: string, cls: Uint8Array, at: number): string[] {
  const segs: Array<[number, number]> = [];
  let depth = 1;
  let from = at + 1;
  for (let k = at + 1; k < src.length; k++) {
    if (cls[k] !== 0) continue;
    const ch = src[k];
    if (OPEN.has(ch)) depth++;
    else if (CLOSE.has(ch)) { depth--; if (depth === 0) { segs.push([from, k]); break; } }
    else if (ch === ',' && depth === 1) { segs.push([from, k]); from = k + 1; }
  }
  const out: string[] = [];
  const opts = segs.length > 0 && src.slice(segs[0][0], segs[0][1]).trim().startsWith('{'); // (title, { options }, callback, …trailing)
  const cb = opts ? 1 : 0;
  const keep: string[] = [];
  segs.forEach(([x, y], n) => { if (n !== cb) { const t = normalise(src, cls, x, y); if (t) keep.push(t); } });
  if (keep.length) out.push(`D:args:${keep.join(',')}`);
  if (segs[cb]) { // the callback's header (parameters): `async (t) =>` / `function (assert)`; a parameter named like the assert identifier would shadow it
    const t = normalise(src, cls, segs[cb][0], segs[cb][1]);
    const m = /^[\s\S]*?=>|^[^{]*/.exec(t);
    out.push(`D:cb:${m ? m[0].trim() : t}`);
  }
  return out;
}

/** JS/TS statements — see the file header for the kinds. Bodies are scanned on; an assertion-shaped call nothing reads is unknown shape. */
function statementsJs(src: string, cls: Uint8Array): Extracted {
  const out: string[] = [];
  const ranges: Array<[number, number]> = [];
  const n = src.length;
  let i = 0;
  const skipWord = (): void => { while (i < n && /[\w$]/.test(src[i])) i++; };
  while (i < n) {
    if (cls[i] !== 0 || !/[A-Za-z_$]/.test(src[i]) || (i > 0 && /[\w$.]/.test(src[i - 1]) && cls[i - 1] === 0)) { i++; continue; }
    const code = [...src.slice(i, Math.min(n, i + 300))].map((ch, k) => (cls[i + k] === 0 ? ch : cls[i + k] === 2 ? ' ' : '\u0001')).join('');
    const take = (kind: string, end: number, ctx = ''): void => { out.push(`${kind}:${ctx}${normalise(src, cls, i, end)}`); ranges.push([i, Math.max(end, i + 1)]); i = Math.max(end, i + 1); };
    const decl = JS_DECL_HEAD.test(code);
    if (decl) {
      const end = endOfJs(src, cls, i, true);
      if (end < 0) return { ok: false, why: 'unbalanced brackets in a statement' };
      const at = i;
      out.push(`D:${normalise(src, cls, i, end)}`);
      if (src[end] === ',') for (const x of declExtras(src, cls, end)) out.push(x);
      ranges.push([at, Math.max(end, at + 1)]);
      i = Math.max(end, i + 1);
      continue;
    }
    const assertHead = JS_ASSERT_HEAD.test(code) || /^[\w$.\])[('"]*\.should\b/.test(code);
    const pin = /^(?:export\s+)?(?:import|const|let|var)\b/.test(code) || /^(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+(?:[\w$]+)/.test(code) || /^[\w$.]+\.(?:assert|expect|verify)\w*\s*=(?![=>])/.test(code) || new RegExp(`^(?:(?:globalThis|global|window|self)\\.)?(?:${RUNNER_NAMES})\\s*=(?![=>])`).test(code);
    if (pin) {
      const end = endOfJs(src, cls, i, false);
      if (end < 0) return { ok: false, why: 'unbalanced brackets in a statement' };
      const raw = src.slice(i, end);
      const fn = /^(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+([\w$]+)/.exec(raw);
      if (/^(?:export\s+)?(?:import|const|let|var)\b/.test(raw) ? pinnedBinding(raw) : fn ? new RegExp(`^(?:${RUNNER_NAMES})$`).test(fn[1]) || DEF_NAME_RE.test(fn[1]) : true) { take('B', end); continue; }
      if (/^(?:export\s+)?(?:const|let|var)\b/.test(raw) && SHAPED_RE.test([...raw].map((ch, k) => (cls[i + k] === 0 ? ch : ' ')).join(''))) { const c = contextJs(src, cls, i); take('A', end, c.chain ? `[${c.chain}]` : ''); continue; }
      skipWord(); continue;
    }
    if (assertHead) {
      const end = endOfJs(src, cls, i, false);
      if (end < 0) return { ok: false, why: 'unbalanced brackets in a statement' };
      const c = contextJs(src, cls, i);
      const pre = prefixJs(src, cls, i);
      const ctx = [c.chain, pre].filter(Boolean).join(' || ');
      take('A', end, ctx ? `[${ctx}]` : '');
      continue;
    }
    if (/^(?:return|throw|break|continue)\b/.test(code)) {
      const c = contextJs(src, cls, i);
      if (c.inTest) { const end = endOfJs(src, cls, i, false); if (end < 0) return { ok: false, why: 'unbalanced brackets in a statement' }; take('C', end, c.chain ? `[${c.chain}]` : ''); continue; }
    }
    if (stmtStart(src, cls, i)) { // a statement that CALLS an assertion-shaped name without starting with it (`request(app).get('/').expect(200)`, `expectOk(r)`, `sinon.assert.x()`)
      const end = endOfJs(src, cls, i, false);
      if (end > i && SHAPED_RE.test([...src.slice(i, end)].map((ch, k) => (cls[i + k] === 0 ? ch : ' ')).join(''))) {
        const c = contextJs(src, cls, i);
        const pre = prefixJs(src, cls, i);
        const ctx = [c.chain, pre].filter(Boolean).join(' || ');
        take('A', end, ctx ? `[${ctx}]` : '');
        continue;
      }
    }
    skipWord();
  }
  const un = unreadAssertion(src, cls, ranges);
  if (un) return { ok: false, why: `an assertion-shaped call the extractor does not read (${un})` };
  return { ok: true, family: 'js', statements: out };
}

const PY_ASSERT_HEAD = /^(?:(?:await)\s+)?(?:(?:async\s+)?with\s+)?(?:assert\b|self\.(?:assert\w*|fail\w*|skipTest)\s*\(|assert\w*\s*\(|pytest\.(?:raises|warns|approx|fail|skip|xfail|importorskip|deprecated_call)\b|unittest\.(?:TestCase\.)?assert\w*\s*\(|(?:sys|os)\.(?:_exit|exit)\s*\(|exit\s*\(|quit\s*\(|raise\s+SystemExit\b|raise\s+(?:\w+\.)*\w*Skip\w*|pytestmark\s*=)/;
const PY_DECL_HEAD = /^(?:@pytest\.mark\.|@unittest\.(?:skip|expectedFailure)|@(?:\w+\.)*skip\w*\b|(?:async\s+)?def\s+test\w*\s*\(|class\s+Test\w*)/;

/** Python statements: logical lines (backslash / bracket continuation) whose head matches, or that call an assertion-shaped name (`m.assert_called_with(1)`); each carries the non-test blocks enclosing it
 *  (`def _unused():`, `if x:`, `try:`) and, inside a test, `return` / `raise` / `break` / `continue` / `yield` lines are pinned. The first line keeps its indentation (it is semantic). */
function statementsPy(src: string, cls: Uint8Array): Extracted {
  const out: string[] = [];
  const ranges: Array<[number, number]> = [];
  const n = src.length;
  const stack: Array<{ indent: number; head: string; decl: boolean; test: boolean }> = [];
  let i = 0;
  while (i < n) {
    // one logical line starting at i
    let depth = 0;
    let k = i;
    for (; k < n; k++) {
      if (cls[k] !== 0) continue;
      const ch = src[k];
      if (OPEN.has(ch)) depth++;
      else if (CLOSE.has(ch)) depth--;
      else if (ch === '\\' && src[k + 1] === '\n') k++;
      else if (ch === '\n' && depth <= 0) break;
    }
    if (depth > 0) return { ok: false, why: 'unbalanced brackets in a statement' };
    const end = k;
    let s = i;
    while (s < end && /[ \t]/.test(src[s])) s++;
    if (s < end && cls[s] === 0) {
      const indent = s - i;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const head = [...src.slice(s, Math.min(end, s + 400))].map((ch, m) => (cls[s + m] === 0 ? ch : cls[s + m] === 2 ? ' ' : '\u0001')).join('');
      const text = normalise(src, cls, s, end);
      const decl = PY_DECL_HEAD.test(head);
      const inTest = stack.some((x) => x.test);
      const lastDecl = stack.map((x) => x.decl).lastIndexOf(true);
      const chain = stack.slice(lastDecl + 1).map((x) => x.head).join(' > ');
      const ctx = chain ? `[${chain}]` : '';
      const defName = /^(?:async\s+)?def\s+((?:assert|expect|verify|fail)(?:[A-Z_]\w*)?)\s*\(/.exec(head);
      const patching = /^[\w.]+\.(?:assert|expect|verify)\w*\s*=(?!=)/.test(head) || (head.startsWith('@') && /(?:patch|mock)[\w.]*\(.*\b(?:assert|expect|verify)/i.test(src.slice(s, end)));
      const shaped = !decl && !defName && !patching && !/^(?:async\s+def|def|class|import|from)\b/.test(head) && SHAPED_RE.test(head.replace(/\u0001+/g, ' '));
      if (defName) { // an assertion-NAMED definition: its WHOLE block is pinned (a gutted `def assertEqual(self, a, b): pass` must not pass)
        let bend = end;
        for (let p = end + 1; p < n; ) {
          let le = src.indexOf('\n', p); if (le < 0) le = n;
          const lt = src.slice(p, le);
          if (lt.trim() === '') { p = le + 1; continue; }
          if (lt.length - lt.trimStart().length <= indent) break;
          bend = le; p = le + 1;
        }
        out.push(`B:${src.slice(i, s)}${blockText(src, cls, s, bend)}`); ranges.push([s, bend]);
        i = bend + 1; continue;
      }
      if (patching) { out.push(`B:${src.slice(i, s)}${src.slice(s, end).replace(/\s+/g, ' ').trim()}`); ranges.push([s, end]); }
      else if (decl) { out.push(`D:${src.slice(i, s)}${text}`); ranges.push([s, end]); }
      else if (PY_ASSERT_HEAD.test(head) || shaped) { out.push(`A:${ctx}${src.slice(i, s)}${text}`); ranges.push([s, end]); }
      else if (inTest && /^(?:return|raise|break|continue|yield)\b/.test(head)) { out.push(`C:${ctx}${src.slice(i, s)}${text}`); ranges.push([s, end]); }
      if (/:$/.test(text.split('\n').pop() ?? '') && !decl) stack.push({ indent, head: text, decl: false, test: false });
      else if (decl && /:$/.test(text.split('\n').pop() ?? '') && /^(?:async\s+def|def|class)\b/.test(head)) stack.push({ indent, head: text, decl: true, test: /^(?:async\s+)?def\b/.test(head) });
    }
    i = end + 1;
  }
  const un = unreadAssertion(src, cls, ranges);
  if (un) return { ok: false, why: `an assertion-shaped call the extractor does not read (${un})` };
  return { ok: true, family: 'python', statements: out };
}

/** The contract statements of one file's text. Unknown extension / unlexable / balanced-bracket failure / zero statements with an assertion ⇒ ok:false. */
export function extractAssertions(path: string, text: string): Extracted {
  const family = familyOf(path);
  if (!family) return { ok: false, why: `${path}: no assertion extractor for this file type (JS/TS and Python only) — unknown shape, fail closed` };
  const cls = family === 'js' ? lexJs(text) : lexPy(text);
  if (!cls) return { ok: false, why: `${path}: could not tokenise it (unterminated string / comment / template / regex) — unknown shape, fail closed` };
  const r = family === 'js' ? statementsJs(text, cls) : statementsPy(text, cls);
  if (!r.ok) return { ok: false, why: `${path}: ${r.why} — unknown shape, fail closed` };
  if (!r.statements.some((s) => s.startsWith('A:'))) return { ok: false, why: `${path}: no assertion recognised in it (expect / assert / should / t.* …) — nothing the check could pin, fail closed` };
  return r;
}

const preview = (s: string): string => JSON.stringify(s.length > 90 ? `${s.slice(0, 87)}…` : s);

/** Compare the contract statements of the old and new bytes of ONE file: identical in content and order, else the first difference named. */
export function compareAssertions(path: string, oldText: string, newText: string): Compared {
  const a = extractAssertions(path, oldText);
  if (!a.ok) return { ok: false, kind: 'unknown-shape', why: `old bytes: ${a.why}` };
  const b = extractAssertions(path, newText);
  if (!b.ok) return { ok: false, kind: 'unknown-shape', why: `new bytes: ${b.why}` };
  const x = a.statements;
  const y = b.statements;
  const same = x.length === y.length && x.every((s, k) => s === y[k]);
  if (same) return { ok: true };
  const sortedEq = x.length === y.length && [...x].sort().join('\0') === [...y].sort().join('\0');
  if (sortedEq) return { ok: false, kind: 'reordered', why: `${path}: the assertion / test statements are reordered (same statements, other order)` };
  const ys = new Set(y);
  const xs = new Set(x);
  const removed = x.find((s) => !ys.has(s));
  const added = y.find((s) => !xs.has(s));
  if (removed !== undefined && added !== undefined) return { ok: false, kind: 'modified', why: `${path}: an assertion / test statement changed: ${preview(removed.slice(2))} → ${preview(added.slice(2))}` };
  if (removed !== undefined) return { ok: false, kind: 'removed', why: `${path}: an assertion / test statement was removed: ${preview(removed.slice(2))}` };
  if (added !== undefined) return { ok: false, kind: 'added', why: `${path}: an assertion / test statement was added: ${preview(added.slice(2))}` };
  return { ok: false, kind: x.length > y.length ? 'removed' : 'added', why: `${path}: a duplicated assertion / test statement was ${x.length > y.length ? 'removed' : 'added'}` };
}

/** sha256 of every file's contract statements (sorted by path): the identity of "what the tests assert", independent of the harness around it. */
export function assertionsHash(files: Record<string, string[]>): string {
  const h = crypto.createHash('sha256');
  for (const p of Object.keys(files).sort()) { h.update(`${p}\0${files[p].length}\n`); for (const s of files[p]) h.update(`${s.length}:${s}\n`); }
  return h.digest('hex');
}

/** Compare every file (old and new texts keyed by path, SAME path set) and hash the NEW statements. First refusal wins. */
export function compareFrozenSets(oldTexts: Record<string, string>, newTexts: Record<string, string>): { ok: true; assertionsHash: string; statements: number } | Exclude<Compared, { ok: true }> {
  const po = Object.keys(oldTexts).sort();
  const pn = Object.keys(newTexts).sort();
  if (po.join('\0') !== pn.join('\0')) return { ok: false, kind: 'unknown-shape', why: `a harness-only amend keeps the SAME file set (frozen: ${po.join(', ')}; given: ${pn.join(', ')}): adding or removing a test file changes what is asserted — use the decision amend` };
  const all: Record<string, string[]> = {};
  let count = 0;
  for (const p of po) {
    const c = compareAssertions(p, oldTexts[p], newTexts[p]);
    if (!c.ok) return c;
    const e = extractAssertions(p, newTexts[p]);
    if (!e.ok) return { ok: false, kind: 'unknown-shape', why: e.why };
    all[p] = e.statements;
    count += e.statements.filter((x) => x.startsWith('A:')).length;
  }
  return { ok: true, assertionsHash: assertionsHash(all), statements: count };
}

/** Multiset line diff of the NON-assertion text: the trimmed non-empty lines only in the old (removed) / only in the new (added) bytes, per file. What the coordinator attests when it stamps a harness-only amend. */
export function changedLines(oldTexts: Record<string, string>, newTexts: Record<string, string>): { added: number; removed: number; reorderOnly: boolean; sample: string[] } {
  let added = 0;
  let removed = 0;
  const sample: string[] = [];
  for (const p of Object.keys(newTexts).sort()) {
    const bag = new Map<string, number>();
    for (const l of (oldTexts[p] ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) bag.set(l, (bag.get(l) ?? 0) + 1);
    const plus: string[] = [];
    for (const l of newTexts[p].split('\n').map((x) => x.trim()).filter(Boolean)) { const c = bag.get(l) ?? 0; if (c > 0) bag.set(l, c - 1); else plus.push(l); }
    const minus: string[] = [];
    for (const [l, c] of bag) for (let k = 0; k < c; k++) minus.push(l);
    added += plus.length; removed += minus.length;
    for (const l of minus) sample.push(`- ${p}: ${l.length > 140 ? `${l.slice(0, 137)}…` : l}`);
    for (const l of plus) sample.push(`+ ${p}: ${l.length > 140 ? `${l.slice(0, 137)}…` : l}`);
  }
  const differs = Object.keys(newTexts).some((p) => newTexts[p] !== oldTexts[p]);
  return { added, removed, reorderOnly: differs && added === 0 && removed === 0, sample };
}
