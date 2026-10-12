// Render smoke-test for the desktop's tool lines (#374): ONE always-visible line per tool — the phone's glyph (… / ✓ / ✗) and label —
// built by the shared render-item builder and rendered by <ToolGroup>; a click opens the tool's card (the SSR `defaultOpenIds` branch).
// The unit suite (src/shared/agent-render-items.test.ts) proves the rows; this proves they REACH the DOM as lines, not a summary.
// SELECTOR CONTRACT: class / data-* / rendered TEXT only. Computed colours (red ✗) are asserted in the built-app drive (e2e-tool-lines.mjs).

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const store = require_('node:fs').globSync?.(process.cwd() + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = process.env.ORCHESTRA_ESBUILD ? require_(process.env.ORCHESTRA_ESBUILD) : loadEsbuild();

import { renderToString } from 'react-dom/server';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'tool-lines-smoke.mjs');
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'tool-lines-entry.tsx');
const entry = `
import { ToolGroup } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/ToolGroup.tsx'))};
import { buildRenderItems } from ${JSON.stringify(path.join(repoRoot, 'src/shared/agent-render-items.ts'))};
export { ToolGroup, buildRenderItems };
`;
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(entryFile, entry);
await build({
  entryPoints: [entryFile],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
const { ToolGroup, buildRenderItems } = await import(`${outfile}?t=${Date.now()}`);

const text = (html) => html.replace(/<!-- -->/g, '');
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const tool = (id, name, input, result) => ({
  id, role: 'tool', done: true,
  toolUse: { toolUseId: id, name, inputJson: '', input },
  ...(result ? { toolResult: { content: result.content ?? 'out', isError: !!result.isError } } : {}),
});

// The seeded run the drive uses: an ok Bash, a failed Bash, a running Edit.
const messages = [
  tool('t-ok', 'Bash', { description: 'run the suite', command: 'pnpm test' }, { content: 'all green' }),
  tool('t-fail', 'Bash', { command: 'grep -r nothing .' }, { content: 'exit status 1', isError: true }),
  tool('t-run', 'Edit', { file_path: '/repo/src/shared/foo.ts', old_string: 'a\nb', new_string: 'a\nb\nc\nd' }),
];
const group = buildRenderItems(messages).find((i) => i.kind === 'tool-group');
const render = (extra = {}) => text(renderToString(React.createElement(ToolGroup, { rows: group.rows, ...extra })));

console.log('Tool lines — closed (the default):');
const closed = render();
const lines = closed.split('class="av-tool-line ').slice(1);
check('one line per tool (3)', lines.length === 3, `got ${lines.length}`);
check('ok line: ✓ glyph + phone label', /av-tool-line-ok[^]*?data-state="ok"[^]*?>✓<[^]*?>Bash · run the suite</.test(lines[0] ? 'class="av-tool-line ' + lines[0] : ''), lines[0]);
check('failed line: ✗ glyph + its label, error class', /av-tool-line-error[^]*?>✗<[^]*?>Bash · grep -r nothing \.</.test('class="av-tool-line ' + (lines[1] ?? '')), lines[1]);
check('running line: … glyph + Edit label', /av-tool-line-running[^]*?>…<[^]*?>Edit · shared\/foo\.ts</.test('class="av-tool-line ' + (lines[2] ?? '')), lines[2]);
check('glyphs carry the state word for assistive tech', ['aria-label="done"', 'aria-label="failed"', 'aria-label="running"'].every((w) => closed.includes(w)));
check('every line is a closed toggle', (closed.match(/aria-expanded="false"/g) ?? []).length === 3 && !closed.includes('aria-expanded="true"'));
check('no card body is mounted while closed', !closed.includes('av-tool-line-body') && !closed.includes('av-tool-card'));
check('NO summary row (« Used N tools », « Created », « Ran ») and no old run header', !/Used \d+ tools?|Created |Ran (a|\d+) |av-tool-run-header|av-tool-run-label/.test(closed));
check('NO ±diff count on the Edit line', !/av-diff-(add|del)|av-tool-run-diff|[+−]\d/.test(closed));

console.log('\nTool lines — one opened (the click, via the SSR branch):');
const open = render({ defaultOpenIds: ['t-fail'] });
check('exactly one body is mounted', (open.match(/av-tool-line-body/g) ?? []).length === 1);
check('it is the failed tool\'s card (its error output is shown)', open.includes('av-tool-errored') && open.includes('exit status 1'));
check('only that line reports aria-expanded="true"', (open.match(/class="av-tool-line-head" aria-expanded="true"/g) ?? []).length === 1 && /av-tool-line-error av-open/.test(open));
check('closed and open genuinely differ', open !== closed && open.length > closed.length);
// A card that is closed by default (an ok Bash) must show its output the moment the line opens — only `startOpen` does that.
const openOk = render({ defaultOpenIds: ['t-ok'] });
check('an ok Bash line opens to its card WITH the output shown (startOpen)', openOk.includes('av-tool-card') && openOk.includes('all green'), 'the card mounted closed: the click would need a second click');
check('the ok line opened, the failed one did not', /av-tool-line-ok av-open/.test(openOk) && !/av-tool-line-error av-open/.test(openOk));

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
