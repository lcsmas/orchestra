#!/usr/bin/env node
// Mutants of the #341 clauses (built-in command output → `command-output` row, live + backfill).
// Each mutant edits a COPY of src/shared (nothing on disk in the repo) and must turn
// src/shared/builtin-command-output.test.ts red. Controls: the unmutated copy must pass with 0 skipped,
// and every anchor must match EXACTLY once (a drifted anchor throws instead of "surviving").
// Run: node scripts/command-output-mutants.mjs   (exit 0 = every mutant killed)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST = 'src/shared/builtin-command-output.test.ts';
const EV = 'src/shared/agent-events.ts';
const TR = 'src/shared/agent-transcript.ts';

/** [id, file, [[from, to], …]] — `from` must occur exactly once in `file`. */
const MUTANTS = [
  ['dup-guard-removed', EV, [["if (localCmd && seenLocalCommand(ctx, msg.uuid)) return [];", '']]],
  ['dup-guard-after-usage', EV, [
    ["if (localCmd && seenLocalCommand(ctx, msg.uuid)) return [];", ''],
    ["      if (localCmd) {\n        // Unwrap", "      if (localCmd && seenLocalCommand(ctx, msg.uuid)) return out;\n      if (localCmd) {\n        // Unwrap"],
  ]],
  ['notice-not-emitted', EV, [["if (text) out.push(stamp(ctx, { type: 'notice', kind: 'command-output', text }));", '']]],
  ['empty-output-rendered', EV, [["if (text) out.push(stamp(ctx, { type: 'notice', kind: 'command-output', text }));", "out.push(stamp(ctx, { type: 'notice', kind: 'command-output', text }));"]]],
  ['dedupe-keyed-by-message-id', EV, [["if (localCmd && seenLocalCommand(ctx, msg.uuid)) return [];", "if (localCmd && seenLocalCommand(ctx, (msg.message as { id?: string })?.id)) return [];"]]],
  ['text-block-fallback-dropped', EV, [["wrappedCommandOutput(msg.local_command_source) ?? textBlocksOf(content)", "wrappedCommandOutput(msg.local_command_source) ?? ''"]]],
  ['raw-xml-leak', EV, [["wrappedCommandOutput(msg.local_command_source) ?? textBlocksOf(content)", "msg.local_command_source ?? ''"]]],
  ['every-assistant-is-local-command', EV, [["const localCmd = typeof msg.local_command_source === 'string';", "const localCmd = true;"]]],
  ['uuid-memory-unbounded', EV, [["if (seen.size > LOCAL_COMMAND_UUID_CAP) seen.delete(seen.values().next().value as string);", '']]],
  ['uuidless-deduped', EV, [["if (typeof uuid !== 'string' || !uuid) return false;", '']]],
  ['uuid-memory-global', EV, [["const seen = (ctx.localCommandUuids ??= new Set<string>());", "const seen = ((globalThis as any).__cmdSeen ??= new Set<string>());"]]],
  ['unwrapped-passthrough', EV, [["return c.kind === 'command-output' ? c.text : null;", "return c.kind === 'command-output' ? c.text : content;"]]],
  ['non-string-not-guarded', EV, [["  if (typeof content !== 'string') return null;\n  const c = classifyUserText(content);", "  const c = classifyUserText(content as string);"]]],
  ['backfill-branch-off', TR, [["if (entry.type === 'system') {", "if (false) {"]]],
  ['backfill-any-subtype', TR, [["if (entry.subtype === 'local_command') {", "if (true) {"]]],
  ['backfill-empty-rendered', TR, [["if (text) out.push(st(ctx, { type: 'notice', kind: 'command-output', text }));", "out.push(st(ctx, { type: 'notice', kind: 'command-output', text: text ?? '' }));"]]],
  ['backfill-clock-not-line-time', TR, [["if (text) out.push(st(ctx, { type: 'notice', kind: 'command-output', text }));", "if (text) out.push(stamp(ctx, { type: 'notice', kind: 'command-output', text }));"]]],
  ['backfill-raw-content', TR, [["const text = wrappedCommandOutput(entry.content);", "const text = entry.content as string;"]]],
  // INSTRUMENT CHECK: a provably EQUIVALENT edit (a local-command message carries no tool_use block, so falling through
  // to the tool_use lift changes nothing). It MUST survive — proof the harness can say SURVIVED, not only KILLED.
  ['equiv-fallthrough-after-notice', EV, [["        return out; // nothing else to lift: a local command has no tool_use blocks", ""]], 'equivalent'],
];

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d);
  }
}

function runTest(dir) {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', TEST], { cwd: dir, encoding: 'utf8' });
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? NaN);
  return { rc: r.status, pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), tail: (r.stderr || '').slice(-300) };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-out-mutants-'));
const fresh = (id) => {
  const dir = path.join(work, id);
  copyTree(path.join(REPO, 'src', 'shared'), path.join(dir, 'src', 'shared'));
  copyTree(path.join(REPO, 'scripts', 'fixtures', 'payloads'), path.join(dir, 'scripts', 'fixtures', 'payloads'));
  return dir;
};

let bad = 0;
try {
  const base = runTest(fresh('control'));
  const baseOk = base.fail === 0 && base.skipped === 0 && base.pass > 0 && base.pass === base.tests;
  console.log(`CONTROL unmutated: pass=${base.pass} fail=${base.fail} skipped=${base.skipped} -> ${baseOk ? 'CLEAN' : 'DIRTY'}`);
  if (!baseOk) { console.log(base.tail); process.exit(2); }

  for (const [id, file, edits, kind] of MUTANTS) {
    const dir = fresh(id);
    const target = path.join(dir, file);
    let src = fs.readFileSync(target, 'utf8');
    for (const [from, to] of edits) {
      const n = src.split(from).length - 1;
      if (n !== 1) throw new Error(`PATTERN-GONE ${id}: anchor matched ${n}x in ${file}: ${JSON.stringify(from.slice(0, 70))}`);
      src = src.replace(from, () => to);
    }
    fs.writeFileSync(target, src);
    const r = runTest(dir);
    const killed = r.fail > 0 || r.rc !== 0;
    if (kind === 'equivalent') {
      if (killed) bad++; // an "equivalent" edit that turns a test red means the analysis (or the test) is wrong
      console.log(`${killed ? 'UNEXPECTED-KILL' : 'SURVIVED (equivalent, expected)'} ${id.padEnd(34)} fail=${r.fail}/${r.tests}`);
      continue;
    }
    if (!killed) bad++;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${id.padEnd(34)} fail=${r.fail}/${r.tests}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
const real = MUTANTS.filter((m) => m[3] !== 'equivalent').length;
console.log(bad === 0 ? `MUTANTS: ${real}/${real} killed (+${MUTANTS.length - real} equivalent survived as predicted)` : `MUTANTS: ${bad} BAD of ${MUTANTS.length}`);
process.exit(bad === 0 ? 0 : 1);
