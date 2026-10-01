// Render smoke for avis de tâche rows (task notices, #273).
//
// The unit suite proves the parser; this proves the ROW: collapsed it shows our
// label (never the raw XML, never the agent result), a failure is red with its
// reason on the line, a group keeps its failure count, and the open branch
// renders the result + folded note. Click-to-expand is proven in the built app.
// Selector contract: class, data-*, or rendered text — never tag/position.
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const store =
      require_('node:fs').globSync?.(
        process.cwd() + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild',
      ) ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = process.env.ORCHESTRA_ESBUILD
  ? require_(process.env.ORCHESTRA_ESBUILD)
  : loadEsbuild();

import { renderToString } from 'react-dom/server';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'task-notice-rows-smoke.mjs');
const agentDir = path.join(repoRoot, 'src/renderer/components/agent');

const entry = `
import { TaskNoticeGroup } from ${JSON.stringify(path.join(agentDir, 'TaskNoticeGroup.tsx'))};
import { parseTaskNotice } from ${JSON.stringify(path.join(repoRoot, 'src/shared/task-notices.ts'))};
export { TaskNoticeGroup, parseTaskNotice };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'task-notice-rows-entry.tsx');
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
  logLevel: 'silent',
});
globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const { TaskNoticeGroup, parseTaskNotice } = await import(`${outfile}?t=${Date.now()}`);
const text = (html) => html.replace(/<!-- -->/g, '');
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const env = (inner) => `<task-notification>\n${inner}\n</task-notification>`;
const item = (id, body) => {
  const notice = parseTaskNotice(body);
  if (!notice) throw new Error(`fixture ${id} did not parse`);
  return { message: { id, role: 'user', origin: 'task notification', text: body, done: true }, notice };
};
const render = (items, defaultOpen = false) =>
  text(renderToString(React.createElement(TaskNoticeGroup, { items, defaultOpen })));

const DONE = item('m1', env(`<task-id>aec</task-id>
<output-file>/tmp/x/aec.output</output-file>
<status>completed</status>
<summary>Agent "Pre-review commit-lock delta" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result>RESULT_MARKER line one\n\nmore of the report</result>
<usage><tool_uses>38</tool_uses><duration_ms>252000</duration_ms></usage>`));
const FAILED = item('m2', env(`<task-id>ab0</task-id>
<status>failed</status>
<summary>Agent "Lens 2" failed: Agent terminated early due to an API error: You've hit your session limit</summary>`));
const EVENT = item('m3', env(`<task-id>byj</task-id>
<summary>Monitor event: "OPS transcript"</summary>
<event>OPS transcript updated at 15:06:51</event>`));

console.log('Single notice — collapsed:');
const one = render([DONE]);
check('renders a task-notice row', one.includes('av-tnotice') && one.includes('data-task-notice="ok"'));
check('is CLOSED by default', one.includes('av-closed') && one.includes('aria-expanded="false"'));
check('shows our label', one.includes('Agent “Pre-review commit-lock delta” finished'));
check('shows usage meta', one.includes('4m 12s · 38 tools'));
check('does NOT leak raw XML', !one.includes('&lt;task-notification') && !one.includes('<summary>'), one.slice(0, 200));
check('does NOT leak the result while collapsed', !one.includes('RESULT_MARKER'));
check('does NOT leak the model-facing note', !one.includes('fires each time'));
check('a lone notice has no group header', !one.includes('av-tnotice-run'));

console.log('\nSingle notice — expanded (SSR open branch):');
const oneOpen = render([DONE], true);
check('is marked OPEN', oneOpen.includes('av-open') && oneOpen.includes('aria-expanded="true"'));
check('renders the agent result', oneOpen.includes('RESULT_MARKER') && oneOpen.includes('more of the report'));
check('folds the note under a details', /<details[^>]*av-tnotice-note/.test(oneOpen) && oneOpen.includes('fires each time'));
check('offers Open output', oneOpen.includes('Open output'));
check('open and closed differ', oneOpen !== one && oneOpen.length > one.length);

console.log('\nFailure:');
const fail = render([FAILED]);
check('tone is fail', fail.includes('data-task-notice="fail"'));
check('reason is on the collapsed line', fail.includes('session limit'));

console.log('\nMonitor event:');
const ev = render([EVENT]);
check('event text is on the collapsed line', ev.includes('OPS transcript updated at 15:06:51'));

console.log('\nGroup of 3:');
const grp = render([DONE, FAILED, EVENT]);
check('one group header with the count', grp.includes('3 task notices'));
check('failure count survives the collapse', grp.includes('· 1 failed'));
check('collapsed group renders no member rows', !grp.includes('data-task-notice="ok"') && !grp.includes('RESULT_MARKER'));
const grpOpen = render([DONE, FAILED, EVENT], true);
check('open group lists every member row', ['ok', 'fail', 'event'].every((t) => grpOpen.includes(`data-task-notice="${t}"`)));
check('open group keeps members collapsed', !grpOpen.includes('RESULT_MARKER'));

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
