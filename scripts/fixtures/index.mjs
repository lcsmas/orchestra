// Canonical SDK payload fixtures — REAL captures + builders that VALIDATE.
//
// WHY THIS EXISTS (issue #47). Across two fleet retrospectives, 10 of 10
// apparent defects were RIG-SIDE: hand-built payloads that encoded the
// builder's own assumptions rather than what the runtime actually sends —
// a category row missing `kind`, an invented `turn-error` event type, an
// undefined `at`, `ws.model` passed as a context field instead of positionally.
// Each cost a full investigation cycle and produced a PHANTOM defect report
// against working code.
//
// The fix is structural, not advisory: every builder here runs its output
// through the SAME `src/shared` normalizer the app uses, and THROWS when the
// result does not match the shape the producer contract promises. A malformed
// fixture therefore fails LOUDLY AT BUILD TIME, in the harness that built it —
// not silently downstream as a plausible-looking defect in someone else's code.
//
// PROVENANCE — every payload under ./payloads/ is a real capture, not authored:
//   get-context-usage.live.json ......... `Query.getContextUsage()` at CLI
//       2.1.234 / SDK 0.3.216, recorded in docs/research/sdk-runtime-payloads.md
//       §1 (branch research/sdk-runtime-payloads, commit db9507d). Carries BOTH
//       traps: the NESTED `skills.skillFrontmatter[]` object shape (not the
//       flat array `/context` sends) and two `isDeferred` rows.
//   context-command.usage.json .......... the snake_case `context_usage` field
//       the CLI stamps on the synthetic `/context` assistant message, same doc
//       §2. Categories classify via `kind`, NOT `isDeferred` — the two shapes
//       genuinely disagree, which is why both are kept.
//   tool-result-meta.trio.json .......... denied / interrupted / cancelled, the
//       `tool_result_meta` sidecar. RUNTIME SUPERSET: 0 occurrences in sdk.d.ts
//       at SDK 0.3.241, 3 in the CLI 2.1.241 binary (verified by `strings` with
//       a positive and a negative control). Shipped by PR #46 (#26).
//   rich-session.transcript.jsonl ....... 15 REAL Claude Code transcript lines (assistant markdown list + a
//       fenced code block, Read/Edit/Bash tool_use + tool_result pairs, the Edit's structured patch) cut from an
//       Orchestra session on this machine (2026-09-28, repo docs merge; scanned: no keys/emails). Feeds
//       `transcriptToEvents` (the app's history adapter). NO thinking capture exists: the CLI redacts thinking on
//       disk (9177 blocks scanned, 0 non-empty; agent-transcript.ts drops them) and the app renders an empty one as
//       nothing, so an idle pane has no thinking DOM to mount. Used by the UI idle-budget rig (#215).
//   background-tasks-changed.sequence.json  a 4-frame REPLACE-semantics
//       sequence (grow → grow → shrink → empty); frame 1 is the organic capture
//       from docs/research/sdk-runtime-payloads.md §4.
//
// USING THIS LIBRARY — read this before hand-writing ANY payload in a probe,
// harness or E2E script. If a shape you need is missing, ADD IT HERE from a
// real capture rather than inlining a guess at the call site.
//
//   import { liveContextUsage, toolResultMetaTrio } from './fixtures/index.mjs';
//   const usage = liveContextUsage();                    // validated ContextUsage
//   const denied = toolResultMetaTrio().denied;          // validated SdkMessage
//
// Every builder takes an optional `overrides` object so a test can vary ONE
// field while the rest stays real — and the validation still runs, so an
// override that breaks the contract fails here too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeLiveContextUsage,
  normalizeContextCommandUsage,
  isDeferredCategory,
} from '../../src/shared/context-usage.ts';
import { buildContextBreakdown } from '../../src/shared/context-breakdown.ts';
import { normalizeSdkMessage, indexToolResultMeta, toNonExecutionKind, foldEvents, emptySession } from '../../src/shared/agent-events.ts';
import { transcriptToEvents } from '../../src/shared/agent-transcript.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const payloadDir = path.join(here, 'payloads');

/** Fixed clock for `at` stamps: fixtures must be byte-reproducible, and an
 *  undefined/now()-derived `at` was itself one of the 10 rig-side defects. */
export const FIXTURE_AT = 1_700_000_000_000;

class FixtureError extends Error {
  constructor(message) {
    super(`[fixtures] ${message}`);
    this.name = 'FixtureError';
  }
}

/** Throw unless `cond`. This is the whole point of the library — see header. */
function must(cond, message) {
  if (!cond) throw new FixtureError(message);
}

function loadJson(name) {
  const file = path.join(payloadDir, name);
  must(fs.existsSync(file), `captured payload missing: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Deep-merge `overrides` into a clone of `base` (arrays REPLACE wholesale —
 *  a partial array merge is exactly the kind of silent surprise this library
 *  exists to prevent). */
function withOverrides(base, overrides) {
  if (!overrides) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
        ? withOverrides(base[k], v)
        : v;
  }
  return out;
}

// ── shared validation of a normalized ContextUsage ───────────────────────────

const CATEGORY_KINDS = new Set(['used', 'free', 'buffer', 'deferred']);

/** Assert a normalized reading really matches the documented `ContextUsage`
 *  contract in src/shared/context-usage.ts. Every check here corresponds to a
 *  real rig-side defect or to a rule the module's own comments call load-bearing. */
function validateContextUsage(usage, label) {
  must(usage != null, `${label}: normalizer returned null — the payload is not a usable capture`);
  must(Number.isFinite(usage.totalTokens), `${label}: totalTokens must be a finite number`);
  must(
    usage.maxTokens === null || Number.isFinite(usage.maxTokens),
    `${label}: maxTokens must be a number or null (never undefined)`,
  );
  must(
    usage.percentage === null || Number.isFinite(usage.percentage),
    `${label}: percentage must be a number or null — never a fabricated default`,
  );
  must(Number.isFinite(usage.at), `${label}: 'at' must be a finite epoch-ms stamp (undefined 'at' was a real rig defect)`);
  must(
    ['live', 'context-command', 'transcript', 'turn-end'].includes(usage.source),
    `${label}: source '${usage.source}' is not a ContextUsageSource`,
  );

  for (const [i, c] of (usage.categories ?? []).entries()) {
    must(typeof c.name === 'string' && c.name, `${label}: category[${i}] has no display name`);
    must(Number.isFinite(c.tokens), `${label}: category[${i}] '${c.name}' has non-numeric tokens`);
    // Post-normalization this can never fail — BOTH adapters coerce an
    // unrecognized kind to 'used' (context-usage.ts:267 and its live twin),
    // measured. Kept only as a structural backstop against a future adapter
    // that stops normalizing; the guard that actually fires on the wave-1
    // "row missing kind" defect is validateRawCategoryKinds(), below, which
    // reads the RAW payload where `kind` still means something.
    must(
      CATEGORY_KINDS.has(c.kind),
      `${label}: category[${i}] '${c.name}' has kind='${c.kind}' — must be one of ${[...CATEGORY_KINDS].join('|')}`,
    );
  }

  for (const [i, s] of (usage.skills ?? []).entries()) {
    must(typeof s.name === 'string' && s.name, `${label}: skill[${i}] has no name`);
    must(typeof s.source === 'string' && s.source, `${label}: skill[${i}] '${s.name}' has no source`);
    must(Number.isFinite(s.tokens), `${label}: skill[${i}] '${s.name}' has non-numeric tokens`);
    must(
      s.pluginName === undefined || (typeof s.pluginName === 'string' && s.pluginName),
      `${label}: skill[${i}] pluginName must be a non-empty string when present`,
    );
  }

  for (const [i, m] of (usage.mcpTools ?? []).entries()) {
    must(typeof m.name === 'string' && m.name, `${label}: mcpTool[${i}] has no name`);
    // serverName is what makes the panel groupable — a missing one silently
    // collapses every tool under one heading rather than throwing.
    must(typeof m.serverName === 'string' && m.serverName, `${label}: mcpTool[${i}] '${m.name}' has no serverName`);
  }

  for (const [i, f] of (usage.memoryFiles ?? []).entries()) {
    must(typeof f.path === 'string' && f.path, `${label}: memoryFile[${i}] has no path`);
    must(Number.isFinite(f.tokens), `${label}: memoryFile[${i}] has non-numeric tokens`);
  }

  // The breakdown builder is the real downstream consumer: if it cannot build,
  // the fixture is not usable for any panel/render test.
  if (usage.categories?.length) {
    must(buildContextBreakdown(usage) != null, `${label}: buildContextBreakdown() rejected this reading`);
  }
  return usage;
}

/** Validate category `kind` ON THE RAW `/context` PAYLOAD — the only surface
 *  where it is still falsifiable.
 *
 *  WHY THIS IS SEPARATE, measured: `mapCommandCategories` (context-usage.ts:267)
 *  coerces ANY unrecognized kind to `'used'`, and the live adapter derives kind
 *  from `isDeferred`/`color` rather than reading one. So a category row that
 *  reaches the app with a missing or bogus `kind` is INVISIBLE after
 *  normalization — it silently becomes "used" and quietly overstates the
 *  breakdown. That is precisely the wave-1 rig-side defect, and a check placed
 *  after the adapter cannot see it. This one runs BEFORE. */
function validateRawCategoryKinds(rawCategories, label) {
  if (!Array.isArray(rawCategories)) return;
  for (const [i, c] of rawCategories.entries()) {
    if (!c || typeof c !== 'object') continue;
    must(
      'kind' in c,
      `${label}: raw category[${i}] '${c.name}' has NO 'kind' — the /context wire shape always sends one; the adapter would silently coerce it to 'used'`,
    );
    must(
      CATEGORY_KINDS.has(c.kind),
      `${label}: raw category[${i}] '${c.name}' has kind='${c.kind}', not one of ${[...CATEGORY_KINDS].join('|')} — the adapter would silently coerce it to 'used'`,
    );
  }
}

// ── builders ─────────────────────────────────────────────────────────────────

/** The RAW `getContextUsage()` capture, exactly as recorded. Use when the thing
 *  under test is an ADAPTER (it must receive the wire shape, not a normalized
 *  one); use {@link liveContextUsage} for everything else. */
export function rawLiveContextUsagePayload(overrides) {
  return withOverrides(loadJson('get-context-usage.live.json'), overrides);
}

/** Normalized `ContextUsage` from the real camelCase `getContextUsage()`
 *  capture — nested `skills.skillFrontmatter[]`, two deferred rows, pluginName
 *  on the plugin skill. Validated. */
export function liveContextUsage(overrides, at = FIXTURE_AT) {
  const raw = rawLiveContextUsagePayload(overrides);
  const usage = normalizeLiveContextUsage(raw, at);
  validateContextUsage(usage, 'liveContextUsage');
  must(usage.source === 'live', `liveContextUsage: expected source 'live', got '${usage.source}'`);
  // The nested-skills adapter arm is the half a flat-array assumption breaks.
  must(
    (usage.skills ?? []).length > 0,
    'liveContextUsage: skills came back EMPTY — the nested skills.skillFrontmatter[] adapter arm regressed',
  );
  must(
    (usage.categories ?? []).some(isDeferredCategory),
    'liveContextUsage: no deferred category survived — this capture must carry deferred rows',
  );
  return usage;
}

/** The RAW snake_case `/context` `context_usage` capture. */
export function rawContextCommandPayload(overrides) {
  return withOverrides(loadJson('context-command.usage.json'), overrides);
}

/** Normalized `ContextUsage` from the real `/context` capture — the FLAT
 *  `skills[]` array and `kind`-classified categories. Validated. */
export function contextCommandUsage(overrides, at = FIXTURE_AT) {
  const raw = rawContextCommandPayload(overrides);
  // BEFORE normalization: the adapter coerces bad kinds to 'used', so this is
  // the last point at which a malformed `kind` is still detectable.
  validateRawCategoryKinds(raw.categories, 'contextCommandUsage');
  const usage = normalizeContextCommandUsage(raw, at);
  validateContextUsage(usage, 'contextCommandUsage');
  must(
    usage.source === 'context-command',
    `contextCommandUsage: expected source 'context-command', got '${usage.source}'`,
  );
  must(
    (usage.categories ?? []).some(isDeferredCategory),
    'contextCommandUsage: no deferred category survived — this capture must carry deferred rows',
  );
  return usage;
}

/** The denied / interrupted / cancelled `tool_result_meta` trio, as whole SDK
 *  `user` messages ready to hand to `normalizeSdkMessage`.
 *
 *  Validated by NORMALIZING each one and asserting the tool-result event really
 *  carries the structural kind — so a fixture whose sidecar id does not match
 *  its `tool_use_id` (a silent, very plausible authoring slip) fails HERE. */
export function toolResultMetaTrio(overrides) {
  const trio = withOverrides(loadJson('tool-result-meta.trio.json'), overrides);
  for (const [name, msg] of Object.entries(trio)) {
    const sidecar = msg.tool_result_meta;
    must(Array.isArray(sidecar) && sidecar.length > 0, `toolResultMetaTrio.${name}: missing tool_result_meta sidecar`);
    // Wrapper-level sibling of `message`, never inside message.content.
    must(
      msg.message?.content?.every?.((b) => b.type !== 'tool_result' || !('tool_result_meta' in b)),
      `toolResultMetaTrio.${name}: sidecar must ride WRAPPER-LEVEL, not inside a content block`,
    );
    for (const entry of sidecar) {
      must(
        toNonExecutionKind(entry.non_execution_kind) !== null,
        `toolResultMetaTrio.${name}: non_execution_kind '${entry.non_execution_kind}' is not one of the 7 kinds the CLI stamps`,
      );
    }
    must(indexToolResultMeta(sidecar).size === sidecar.length, `toolResultMetaTrio.${name}: a sidecar entry has no usable id`);

    const evs = normalizeSdkMessage(msg, { seq: 0, now: () => FIXTURE_AT });
    const ev = evs.find((e) => e.type === 'tool-result');
    must(ev != null, `toolResultMetaTrio.${name}: normalize produced no tool-result event`);
    must(
      ev.nonExecutionKind === sidecar[0].non_execution_kind,
      `toolResultMetaTrio.${name}: classification came back '${ev.nonExecutionKind}' — the sidecar id likely does not match its tool_use_id`,
    );
  }
  return trio;
}

/** The `background_tasks_changed` sequence — REPLACE semantics, so each frame
 *  is the FULL live set, not a delta. Validated frame-by-frame. */
export function backgroundTasksSequence(overrides) {
  const frames = overrides?.frames ?? loadJson('background-tasks-changed.sequence.json');
  must(Array.isArray(frames) && frames.length > 0, 'backgroundTasksSequence: expected a non-empty frame array');
  const seen = new Set();
  for (const [i, f] of frames.entries()) {
    must(f.type === 'system', `backgroundTasksSequence: frame[${i}] type must be 'system'`);
    must(
      f.subtype === 'background_tasks_changed',
      `backgroundTasksSequence: frame[${i}] subtype must be 'background_tasks_changed'`,
    );
    must(Array.isArray(f.tasks), `backgroundTasksSequence: frame[${i}] must carry a tasks ARRAY (replace-semantics)`);
    for (const [j, t] of f.tasks.entries()) {
      must(typeof t.task_id === 'string' && t.task_id, `backgroundTasksSequence: frame[${i}].tasks[${j}] has no task_id`);
      must(
        typeof t.description === 'string' && t.description,
        `backgroundTasksSequence: frame[${i}].tasks[${j}] '${t.task_id}' has no description`,
      );
      seen.add(t.task_id);
    }
    // Each frame must normalize without throwing — the real consumer path.
    normalizeSdkMessage(f, { seq: 0, now: () => FIXTURE_AT });
  }
  must(seen.size > 1, 'backgroundTasksSequence: a useful sequence exercises more than one task id');
  must(
    frames.some((f) => f.tasks.length === 0),
    'backgroundTasksSequence: must include the DRAIN-to-empty frame — replace-semantics is what a delta reader gets wrong',
  );
  return frames;
}

/** A background-task LIFECYCLE for a mounted panel: the REAL capture's frames carry only the level set (`background_tasks_changed`),
 *  and the fold creates a card only from `task_started` — so the `task_started` / `task_notification` wrappers are DERIVED from the
 *  capture's own (task_id, task_type, description) rows in the sdk.d.ts wire shape, then the real frames interleave. Every message is
 *  normalized by the app's own `normalizeSdkMessage` and the result is validated by folding.
 *  `{ running: true }` (the default; an ordinary idle state — the agent finished its turn while a background shell keeps going) ends with
 *  the FIRST task still running (it is in the last level frame) and the second completed. `{ running: false }` drains: one stopped by
 *  leaving the level set, one completed, nothing running. Returns the SdkMessages. */
export function backgroundTaskLifecycle({ running = true } = {}) {
  const frames = backgroundTasksSequence();
  const rows = new Map();
  for (const f of frames) for (const t of f.tasks) if (!rows.has(t.task_id)) rows.set(t.task_id, t);
  const started = (t) => ({ type: 'system', subtype: 'task_started', task_id: t.task_id, task_type: t.task_type, description: t.description });
  const [first, second] = [...rows.values()];
  must(first && second, 'backgroundTaskLifecycle: the capture must carry two distinct tasks');
  const done = { type: 'system', subtype: 'task_notification', task_id: second.task_id, status: 'completed', summary: second.description };
  const msgs = running
    ? [started(first), frames[0], started(second), frames[1], done, frames[0]]       // ends: live set = [first] → first RUNNING, second completed
    : [started(first), frames[0], started(second), frames[1], frames[2], done, frames[3]];
  for (const [i, m] of msgs.entries()) {
    const evs = normalizeSdkMessage(m, { seq: 0, now: () => FIXTURE_AT });
    must(Array.isArray(evs) && evs.length === 1 && evs[0].type === 'task', `backgroundTaskLifecycle: msg[${i}] (${m.subtype}) did not normalize to one task event`);
  }
  const sess = foldEvents(emptySession('bg'), msgs.flatMap((m) => normalizeSdkMessage(m, { seq: 0, now: () => FIXTURE_AT })));
  const st = Object.values(sess.tasks).map((t) => t.status).sort();
  must(st.length === 2, `backgroundTaskLifecycle: expected 2 task cards, got ${st.length}`);
  if (running) must(st.filter((x) => x === 'running').length === 1 && st.includes('completed'), `backgroundTaskLifecycle(running): expected one running + one completed, got [${st.join(',')}]`);
  else must(!st.includes('running'), `backgroundTaskLifecycle(drained): expected nothing running, got [${st.join(',')}]`);
  return msgs;
}

/** An in-progress TodoWrite (an ordinary idle state: the agent ended its turn with an item still marked in_progress, and the checklist mark
 *  spins by design). SPEC-SHAPED, NOT A CAPTURE: 0 `TodoWrite` tool_use lines exist in any transcript on this machine (this CLI version's
 *  sessions do not emit it), so the two transcript lines follow the tool-input shape documented at renderer tool-util.ts (`TodoItem`) and the
 *  real tool_use / tool_result line envelopes of rich-session.transcript.jsonl. Validated by folding: a TodoWrite card with an in_progress item. */
export function todoWriteLines(activeStatus = 'in_progress') {
  const id = 'toolu_01UibTodoWriteFixture0000';
  const todos = [
    { content: 'Reproduce the idle CPU floor', status: 'completed', activeForm: 'Reproducing the idle CPU floor' },
    { content: 'Budget the metrics catch-all', status: activeStatus, activeForm: 'Budgeting the metrics catch-all' },
    { content: 'Wire the release gate', status: 'pending', activeForm: 'Wiring the release gate' },
  ];
  return [
    { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos }, caller: { type: 'direct' } }] } },
    { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.', is_error: false }] } },
  ].map((o) => JSON.stringify(o));
}

/** A REAL transcript slice → AgentEvents through the app's own history adapter, validated by folding: the session
 *  must settle (running=false) and carry the shapes an idle pane can mount — an assistant message with a markdown list
 *  AND a fenced code block, Read/Edit/Bash tool cards, the Edit's old/new strings (the diff card). Returns
 *  `{ events, session }`; `overrides.jsonl` swaps the text (the self-test's malformed cases). */
export function richSessionEvents(overrides) {
  const file = path.join(payloadDir, 'rich-session.transcript.jsonl');
  must(overrides?.jsonl != null || fs.existsSync(file), `captured payload missing: ${file}`);
  const jsonl = overrides?.jsonl ?? `${fs.readFileSync(file, 'utf8').trimEnd()}\n${todoWriteLines(overrides?.todoStatus).join('\n')}\n`;
  const events = transcriptToEvents(jsonl, { seq: 0, now: () => FIXTURE_AT });
  must(events.length > 0, 'richSessionEvents: the transcript produced no events');
  const session = foldEvents(emptySession('rich'), events);
  must(session.running === false, 'richSessionEvents: the folded session did not settle (running=true) — an idle pane needs a closed turn');
  const assistant = session.messages.filter((m) => m.role === 'assistant');
  must(assistant.some((m) => (m.text ?? '').includes('```')), 'richSessionEvents: no assistant message carries a fenced code block');
  must(assistant.some((m) => /^\s*[-*] /m.test(m.text ?? '')), 'richSessionEvents: no assistant message carries a markdown list');
  const tools = new Set(session.messages.filter((m) => m.role === 'tool').map((m) => m.toolUse?.name));
  for (const t of ['Read', 'Edit', 'Bash']) must(tools.has(t), `richSessionEvents: no ${t} tool card (got ${[...tools].join(',') || 'none'})`);
  if (overrides?.jsonl == null) {   // the default subject must carry the in-progress todo (an explicit `jsonl` is the malformed-slice arms)
    const todo = session.messages.find((m) => m.role === 'tool' && m.toolUse?.name === 'TodoWrite');
    must(Array.isArray(todo?.toolUse?.input?.todos) && todo.toolUse.input.todos.some((t) => t.status === 'in_progress'), 'richSessionEvents: no TodoWrite card with an in_progress item');
  }
  const edit = session.messages.find((m) => m.role === 'tool' && m.toolUse?.name === 'Edit');
  must(typeof edit?.toolUse?.input?.old_string === 'string' && typeof edit?.toolUse?.input?.new_string === 'string', 'richSessionEvents: the Edit card has no old_string/new_string (no diff to render)');
  return { events, session };
}

/** Everything, for a harness that just wants the whole library validated. */
export function allFixtures() {
  return {
    liveContextUsage: liveContextUsage(),
    contextCommandUsage: contextCommandUsage(),
    toolResultMetaTrio: toolResultMetaTrio(),
    backgroundTasksSequence: backgroundTasksSequence(),
    richSessionEvents: richSessionEvents(),
    backgroundTaskLifecycle: backgroundTaskLifecycle(),
  };
}

export { validateContextUsage, validateRawCategoryKinds, FixtureError };
