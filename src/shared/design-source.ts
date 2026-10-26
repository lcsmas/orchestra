// Design mode — React component source (`file:line`) for a picked element (#403).
//
// Two halves with ONE contract:
//  - `reactSourceInPage` runs INSIDE the page (main stringifies it into the
//    injected picker script), reads the React fiber behind the DOM node and
//    returns a RAW `{name, file, line, column, via}` or `null`;
//  - `shapeComponent` runs in main on whatever the page returned: validates it,
//    normalises the path and applies the SECRET FILTER, so nothing that looks
//    like a token/password/key ever reaches the composer.
//
// React 17/18 dev builds set `fiber._debugSource` ({fileName, lineNumber,
// columnNumber}). React 19 removed it (`_debugStack` instead) and Vue has no
// fiber: both come back `null`, the pick keeps today's selector path, no error.

/** The component half of a pick: which file to edit. */
export interface DesignPickComponent {
  /** Owning component's display name (`Anonymous` when it has none). */
  name: string;
  /** Source file, query/scheme stripped. */
  file: string;
  /** 1-based line of the JSX element. */
  line: number;
  /** Column when the JSX transform recorded it. */
  column?: number;
  /** `self`: the element's own JSX site inside the named component's file;
   *  `owner`: the named component's USE-SITE (the element carried no source of its own). */
  via?: 'self' | 'owner';
}

/** What the in-page walker returns, before {@link shapeComponent} validates it. */
export interface RawComponentSource {
  name?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  via?: unknown;
}

/**
 * Walk from a picked DOM element to its React source. SELF-CONTAINED ON
 * PURPOSE: it is injected into the page via `Function.prototype.toString`, so
 * it may reference NOTHING outside its own body (the unit test runs the
 * stringified text in an empty vm context) and uses plain ES5 syntax.
 *
 * Source = the host fiber's `_debugSource` (via 'self': the element's own JSX
 * site, in the file of the component that rendered it), else the nearest
 * `_debugOwner` that has one (via 'owner': that owner's USE-SITE). The name always
 * belongs to the fiber that supplied the source's component: the immediate owner
 * for 'self' (the nearest named `.return` component only when there is no owner
 * at all), the owner that supplied the source for 'owner' — never a mismatched pair.
 */
export function reactSourceInPage(el: any): any {
  try {
    var fiber: any = null;
    var node: any = el;
    for (var hops = 0; node && !fiber && hops < 40; hops++) {
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
          fiber = node[keys[i]];
          break;
        }
      }
      node = node.parentElement;
    }
    if (!fiber) return null;

    // The DOM node caches the fiber from FIRST mount; React 18 writes a re-render's new _debugSource/_debugOwner on
    // whichever alternate is the work-in-progress one, so after an edit (HMR) the cached fiber can hold the OLD line.
    // WHICH alternate is current is what React's own findCurrentFiberUsingSlowPath decides — ported here, bounds kept.
    // NOT "the .return chain ends at root.current": a component that BAILS OUT keeps a stale .return (reviewer F1b, measured);
    // the parent's CHILD list is the reliable pointer, so at each level we look at which alternate the parent actually lists.
    var inList = function (parent: any, target: any): boolean {
      var c = parent.child;
      for (var s = 0; c && s < 100000; s++) {
        if (c === target) return true;
        c = c.sibling;
      }
      return false;
    };
    var freshest = function (f: any): any {
      if (!f || !f.alternate) return f;
      try {
        var alt = f.alternate;
        var a: any = f;
        var b: any = alt;
        for (var lvl = 0; lvl < 5000; lvl++) {
          var parentA = a.return;
          if (!parentA) break;
          var parentB = parentA.alternate;
          if (!parentB) {
            var up = parentA.return;
            if (!up) break;
            a = b = up;
            continue;
          }
          if (parentA.child === parentB.child) {
            if (inList(parentA, a)) return f;
            if (inList(parentA, b)) return alt;
            return f;
          }
          if (a.return !== b.return) {
            a = parentA;
            b = parentB;
          } else if (inList(parentA, a)) {
            a = parentA;
            b = parentB;
          } else if (inList(parentA, b)) {
            b = parentA;
            a = parentB;
          } else if (inList(parentB, a)) {
            a = parentB;
            b = parentA;
          } else if (inList(parentB, b)) {
            b = parentB;
            a = parentA;
          } else {
            return f;
          }
        }
        if (a.tag !== 3 || !a.stateNode) return f; // 3 = HostRoot; anything else (detached, unmounted) degrades
        return a.stateNode.current === a ? f : alt;
      } catch (e) {
        return f; // never let a framework quirk break a pick
      }
    };
    fiber = freshest(fiber);

    var typeName = function (t: any, depth: number): string {
      if (!t || depth > 4) return '';
      if (typeof t === 'function') return typeof t.displayName === 'string' && t.displayName ? t.displayName : t.name || '';
      if (typeof t === 'object') {
        if (typeof t.displayName === 'string' && t.displayName) return t.displayName;
        if (t.render) return typeName(t.render, depth + 1); // forwardRef
        if (t.type) return typeName(t.type, depth + 1); // memo
      }
      return '';
    };
    var usable = function (s: any): boolean {
      return !!s && typeof s.fileName === 'string' && s.fileName !== '' && typeof s.lineNumber === 'number';
    };

    var src: any = fiber._debugSource;
    var via = 'self';
    var named: any = freshest(fiber._debugOwner); // the fiber whose name goes with the source
    if (!usable(src)) {
      via = 'owner';
      src = null;
      var o: any = freshest(fiber._debugOwner);
      for (var n = 0; o && n < 25; n++) {
        if (usable(o._debugSource)) {
          src = o._debugSource;
          named = o;
          break;
        }
        o = freshest(o._debugOwner);
      }
    }
    if (!usable(src)) return null;

    var name = named ? typeName(named.type, 0) : '';
    if (!named) {
      var up: any = fiber.return;
      for (var m = 0; up && m < 100 && !name; m++) {
        if (typeof up.type !== 'string') name = typeName(up.type, 0);
        up = up.return;
      }
    }
    return {
      name: typeof name === 'string' ? name : '',
      file: src.fileName,
      line: src.lineNumber,
      column: typeof src.columnNumber === 'number' ? src.columnNumber : undefined,
      via: via,
    };
  } catch (e) {
    return null; // never let a framework quirk break a pick
  }
}

// ---------------------------------------------------------------------------
// Secret filter
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{3,}/, // JWT
  /\b(?:sk|pk|rk)[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]{15,}/, // sk-ant-api03-…, sk-proj-…, sk_live_… (must carry a digit: `sk-field-selector-component` is a folder)
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bxox[abeprs]-[A-Za-z0-9-]{8,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\/\/[^/\s:@]+:[^/\s@]+@/, // userinfo with a password: https://user:pw@host
  // `token=…`, `password: …`, `api_key=…` — a key name followed by a value.
  /(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth(?:orization)?|session[-_]?id)s?\s*[=:]\s*[^\s&;,]{4,}/i,
];

/** True when `s` looks like a token / password / key (or embeds one).
 *  Conservative on purpose for FILE PATHS: a file merely NAMED `password.tsx`
 *  is not a secret; a high-entropy run, a known token shape or `key=value` is. */
export function looksSecret(s: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(s))) return true;
  // High-entropy blob: a ≥32-char run (path separators and dots split it) mixing letters AND digits.
  for (const run of s.match(/[A-Za-z0-9+_=-]{32,}/g) ?? []) {
    // A kebab/snake-case SLUG (many short words — `orchestra-impl-design-mode-source-403-a6a5fb9d`, an Orchestra
    // worktree dir) is a name, not a token; a token is one or two long random runs.
    const words = run.split(/[-_]/).filter(Boolean);
    if (words.length >= 4 && Math.max(...words.map((w) => w.length)) <= 16) continue;
    const digits = (run.match(/[0-9]/g) ?? []).length;
    const letters = (run.match(/[A-Za-z]/g) ?? []).length;
    if (digits >= 4 && letters >= 4) return true;
  }
  return false;
}

/** What a source path may contain once scheme/query are stripped: letters/digits/marks of any script and ordinary path punctuation. */
const PATH_OK = /^[\p{L}\p{N}\p{M}_\-.\/\\:@$+,~=%!&'()[\] ]+$/u;

const SCHEME_PREFIX = /^(?:webpack-internal:\/\/\/|webpack:\/\/[^/]*\/|vite:\/\/\/?|file:\/\/|https?:\/\/[^/]+\/)/;
const BUNDLER_LAYER_PREFIX = /^\([a-z-]+\)\//; // Next.js `(app-pages-browser)/`

/** Source path as the agent should see it, or `undefined` when it is unusable
 *  or secret-looking. The check runs on the RAW string first so a `?token=…`
 *  query is caught before it is stripped. */
export function normalizeSourcePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const original = raw.trim();
  // Control + FORMAT chars (bidi overrides, zero-width, Unicode tag chars), line separators, and a backtick (it would
  // close the inline-code span the composer wraps the path in): this text is PAGE-AUTHORED, shown as "the file to edit".
  // Variation selectors are invisible \p{Mn}; a run of 3+ combining marks is a rendering trick, not a file name.
  if (original === '' || original.length > 600 || /[\p{Cc}\p{Cf}\u2028\u2029`\uFE00-\uFE0F\u{E0100}-\u{E01EF}]|\p{M}{3,}/u.test(original)) return undefined;
  if (looksSecret(original)) return undefined;
  let p = original.replace(/[?#].*$/, '').replace(SCHEME_PREFIX, '');
  while (BUNDLER_LAYER_PREFIX.test(p)) p = p.replace(BUNDLER_LAYER_PREFIX, '');
  p = p.replace(/^\.\//, '');
  if (p === '' || p.length > 400 || !PATH_OK.test(p)) return undefined;
  return p;
}

const NAME_OK = /^[A-Za-z_$][\w$.:()-]{0,59}$/; // an identifier-ish display name — no spaces, so no sentence can ride in it

/** Validate + sanitise the in-page walker's output. `undefined` = no component
 *  half (React 19, Vue, production build, or anything that failed the filter). */
export function shapeComponent(raw: unknown): DesignPickComponent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as RawComponentSource;
  const file = normalizeSourcePath(r.file);
  if (!file) return undefined;
  if (typeof r.line !== 'number' || !Number.isInteger(r.line) || r.line < 1 || r.line > 10_000_000) return undefined;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const out: DesignPickComponent = {
    name: name && NAME_OK.test(name) && !looksSecret(name) ? name : 'Anonymous',
    file,
    line: r.line,
  };
  if (typeof r.column === 'number' && Number.isInteger(r.column) && r.column >= 0 && r.column <= 100_000) out.column = r.column;
  if (r.via === 'self' || r.via === 'owner') out.via = r.via;
  return out;
}

/** `Counter — /app/src/Counter.jsx:12` (column omitted: agents edit by line); an owner-supplied
 *  source is a use-site, not the element's own line, so say so. */
export function formatComponentLine(c: DesignPickComponent): string {
  return `\`${c.name}\` — ${c.via === 'owner' ? 'rendered at ' : ''}\`${c.file}:${c.line}\``;
}
