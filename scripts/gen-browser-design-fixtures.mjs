// #403 — (re)generates the two React fixture pages of the design-mode rig into
// scripts/fixtures/browser-site/pages/. The OUTPUT is committed; this script is the provenance.
//   design-react18.html  React 18.2.0 UMD *development* builds inlined verbatim (npm tarball files, sha256 in the
//                        page header) + the app compiled by esbuild's REAL automatic dev JSX transform
//                        (jsxDEV(..., {fileName,lineNumber,columnNumber}, this)) behind a jsxDEV shim that
//                        forwards `source` to createElement exactly as react/jsx-dev-runtime does → fiber._debugSource.
//   design-react19.html  the same app bundled by esbuild against the repo's own react@19 (real jsx-dev-runtime,
//                        NODE_ENV=development) → fibers carry _debugStack and NO _debugSource.
// usage: node scripts/gen-browser-design-fixtures.mjs --react18 <dir holding react.development.js + react-dom.development.js>
//   (from `npm pack react@18.2.0 react-dom@18.2.0`, package/umd/). No network is needed at rig time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const esbuild = (() => { try { return require_('esbuild'); } catch { const g = fs.globSync(repo + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild'); if (!g.length) throw new Error('esbuild not resolvable'); return require_(g[0]); } })();
const argv = process.argv.slice(2);
const r18 = argv[argv.indexOf('--react18') + 1];
if (!r18 || argv.indexOf('--react18') < 0) { console.error('usage: --react18 <umd dir>'); process.exit(2); }
const PAGES = path.join(repo, 'scripts/fixtures/browser-site/pages');

// The app, as separate virtual source files so each carries its own `fileName` in the JSX source info.
const FILES = {
  '/fixture/src/Counter.jsx': `function Counter({ label }) {
  const [n, setN] = React.useState(0);
  return (
    <section id="counter">
      <button id="inc" onClick={() => setN(n + 1)}>{label}: {n}</button>
    </section>
  );
}
`,
  '/fixture/src/Greeting.jsx': `function Greeting({ name }) {
  // the <em> is made with plain createElement: NO JSX source → the walker must fall back to the owner's
  return <p id="greet">Hello, {React.createElement('em', { id: 'who' }, name)}</p>;
}
`,
  // a source path that carries a secret (webpack-style ?query) — the secret filter must drop the whole component
  '/fixture/src/Leaky.jsx?token=Zm9vYmFyMTIzNDU2': `function Leaky() {
  return <button id="leak">Leaky (its source path carries a token)</button>;
}
`,
  // a dev server run inside an Orchestra agent worktree records an ABSOLUTE path whose directory is `<repo>-<branch>-<hex8>` —
  // a kebab slug full of digits that a naive entropy rule mistakes for a token
  '/home/dev/.orchestra/worktrees/orchestra-impl-design-mode-source-403-a6a5fb9d/src/Footer.jsx': `function Footer() {
  return <footer id="foot">Footer (source path is an Orchestra worktree)</footer>;
}
`,
  '/fixture/src/App.jsx': `function App() {
  return (
    <main id="app">
      <h1 id="title">Design fixture</h1>
      <Counter label="clicks" />
      <Greeting name="world" />
      <Leaky />
      <Footer />
      <Dyn />
      <Outer />
    </main>
  );
}
`,
};
const ORDER = ['/fixture/src/Counter.jsx', '/fixture/src/Greeting.jsx', '/fixture/src/Leaky.jsx?token=Zm9vYmFyMTIzNDU2', '/home/dev/.orchestra/worktrees/orchestra-impl-design-mode-source-403-a6a5fb9d/src/Footer.jsx', '/fixture/src/App.jsx'];

const CSS = `body{font:16px/1.4 system-ui,sans-serif;margin:24px;background:#f4f6fa;color:#1a1f26}
main{display:block;max-width:560px}h1{margin:0 0 16px}section{margin:0 0 16px}p{margin:0 0 16px}
button{font:inherit;padding:10px 18px;border:1px solid #556;border-radius:6px;background:#fff}`;
const head = (title, extra) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head>
<body><div id="root"></div>
${extra}
</body></html>
`;
const comment = (lines) => `<!--\n${lines.map((l) => '  ' + l).join('\n')}\n-->`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// <Dyn/> is hand-written (not JSX) because its `source.lineNumber` must CHANGE on re-render, like a file edited under HMR:
// window.bumpDyn() re-renders it with line+2. The first-mount fiber cached on the DOM node then goes stale (the new
// _debugSource is written on the other alternate) — the walker must still report the CURRENT line.
const DYN18 = `function Dyn() {
  var st = React.useState(10), line = st[0], setLine = st[1];
  window.bumpDyn = function () { setLine(function (l) { return l + 2; }); };
  return window.jsxDEV('button', { id: 'dyn', children: 'dyn' }, void 0, false, { fileName: '/fixture/src/Dyn.jsx', lineNumber: line, columnNumber: 3 }, this);
}
`;
// <Outer/> holds React.memo(DynMemo): window.bumpEdit() moves DynMemo's JSX line and re-renders it; window.bumpOuter() re-renders
// ONLY Outer, so the memo BAILS OUT — React then leaves a stale .return on the bailed-out subtree, which broke the first
// "which alternate is current" rule (reviewer F1b). window.__dynmLine is the ground truth the rig compares every pick with.
const MEMO18 = `window.__dynmLine = 20;
function DynMemo(props) {
  return window.jsxDEV('button', { id: 'dynm', children: 'm' + props.d }, void 0, false, { fileName: '/fixture/src/DynMemo.jsx', lineNumber: window.__dynmLine, columnNumber: 3 }, this);
}
var MemoDyn = React.memo(DynMemo);
function Outer() {
  var a = React.useState(0), d = a[0], setD = a[1];
  var b = React.useState(0), t = b[0], setT = b[1];
  window.bumpEdit = function () { window.__dynmLine += 2; setD(function (x) { return x + 1; }); };
  window.bumpOuter = function () { setT(function (x) { return x + 1; }); };
  return window.jsxDEV('section', { 'data-t': t, children: window.jsxDEV(MemoDyn, { d: d }, void 0, false, { fileName: '/fixture/src/Outer.jsx', lineNumber: 7, columnNumber: 3 }, this) }, void 0, false, { fileName: '/fixture/src/Outer.jsx', lineNumber: 6, columnNumber: 3 }, this);
}
`;
const MEMO19 = `function Outer() { return null; }
`;
const DYN19 = `function Dyn() {
  var st = React.useState(10), line = st[0], setLine = st[1];
  window.bumpDyn = function () { setLine(function (l) { return l + 2; }); };
  return React.createElement('button', { id: 'dyn' }, 'dyn ' + line);
}
`;
// ── React 18 ──────────────────────────────────────────────────────────────────────────────────────
const umdReact = fs.readFileSync(path.join(r18, 'react.development.js'), 'utf8');
const umdDom = fs.readFileSync(path.join(r18, 'react-dom.development.js'), 'utf8');
let app18 = '';
for (const f of ORDER) {
  const out = esbuild.transformSync(FILES[f], { loader: 'jsx', jsx: 'automatic', jsxDev: true, sourcefile: f, target: 'es2018' });
  app18 += out.code.replace(/^import \{ jsxDEV \} from "react\/jsx-dev-runtime";\n/, '') + '\n';
}
const SHIM = `// react/jsx-dev-runtime for the UMD build: forwards the transform's \`source\` to createElement, which React 18 dev stores as element._source → fiber._debugSource
window.jsxDEV = function (type, props, key, isStatic, source, self) {
  var cfg = Object.assign({}, props, { __source: source, __self: self });
  if (key !== undefined) cfg.key = key;
  var kids = props.children; delete cfg.children;
  return React.createElement.apply(null, [type, cfg].concat(kids === undefined ? [] : Array.isArray(kids) ? kids : [kids]));
};`;
const page18 = head('Design fixture — React 18 dev', [
  comment([
    'GENERATED by scripts/gen-browser-design-fixtures.mjs — do not edit by hand.',
    `react@18.2.0 umd/react.development.js          sha256 ${sha(umdReact)}`,
    `react-dom@18.2.0 umd/react-dom.development.js  sha256 ${sha(umdDom)}`,
    'App compiled with esbuild { jsx: "automatic", jsxDev: true } — the JSX sources:',
    ...ORDER.flatMap((f) => [`--- ${f}`, ...FILES[f].trimEnd().split('\n')]),
  ]),
  `<script>${umdReact}</script>`,
  `<script>${umdDom}</script>`,
  `<script>\n${SHIM}\n${DYN18}\n${MEMO18}\n${app18}\nReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));\n</script>`,
].join('\n'));
fs.writeFileSync(path.join(PAGES, 'design-react18.html'), page18);

// ── React 19 ──────────────────────────────────────────────────────────────────────────────────────
const entry = `import * as React from 'react';\nimport { createRoot } from 'react-dom/client';\nwindow.React = React;\n${DYN19}\n${MEMO19}\n${ORDER.map((f) => FILES[f]).join('\n')}\ncreateRoot(document.getElementById('root')).render(<App />);\n`;
const bundle = await esbuild.build({
  stdin: { contents: entry, loader: 'jsx', resolveDir: repo, sourcefile: '/fixture/src/main.jsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', jsxDev: true,
  minify: true, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
});
const rv = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/react/package.json'), 'utf8')).version;
const page19 = head('Design fixture — React 19 dev', [
  comment([
    'GENERATED by scripts/gen-browser-design-fixtures.mjs — do not edit by hand.',
    `react@${rv} + react-dom (the repo's own copies) bundled by esbuild { jsxDev: true, minify, NODE_ENV=development } — a DEV build:`,
    'fibers carry _debugStack and no _debugSource. Same app as design-react18.html:',
    ...ORDER.flatMap((f) => [`--- ${f}`, ...FILES[f].trimEnd().split('\n')]),
  ]),
  `<script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`,
].join('\n'));
fs.writeFileSync(path.join(PAGES, 'design-react19.html'), page19);
console.log(`design-react18.html ${page18.length} B · design-react19.html ${page19.length} B (react ${rv})`);
