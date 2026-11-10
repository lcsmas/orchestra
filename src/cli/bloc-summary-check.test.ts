// #420 — what another agent READS from `orchestra check` (JSON and markdown) carries a bloc's title, not its markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lotToOutput, renderLotMarkdown } from './bus-verbs.ts';

const lot = (body: string) =>
  ({
    delivery: { id: 1, from_seq: 0, to_seq: 1 },
    replay: false,
    messages: [{ sequence: 1, kind: 'status', sender: 'w', recipient: 'r', thread_id: null, body, created_at: 0 }],
  }) as never;
const id = { runId: 'run', handle: 'r' } as never;

for (const [name, body, title] of [
  ['closed', 'Done:\n```html-render title="Comparatif"\n<div>SRC</div>\n```\nbye', 'Comparatif'],
  ['open', 'Done:\n```html-render title="Tableau"\n<div>SRC', 'Tableau'],
  ['bloc only, no title', '```html-render\n<p>SRC</p>\n```', 'Bloc HTML'],
] as const) {
  test(`check output (${name}): the reader gets the title`, () => {
    const o = lotToOutput(id, lot(body));
    assert.ok(o.messages[0].body.includes(title), o.messages[0].body);
    const md = renderLotMarkdown(o);
    assert.ok(md.includes(`\n${title}`), md);
    for (const s of [JSON.stringify(o), md]) assert.ok(!/SRC|```|<div|<p>/.test(s));
  });
}
