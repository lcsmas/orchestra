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
import { normalizeSdkMessage, indexToolResultMeta, toNonExecutionKind } from '../../src/shared/agent-events.ts';

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

/** Everything, for a harness that just wants the whole library validated. */
export function allFixtures() {
  return {
    liveContextUsage: liveContextUsage(),
    contextCommandUsage: contextCommandUsage(),
    toolResultMetaTrio: toolResultMetaTrio(),
    backgroundTasksSequence: backgroundTasksSequence(),
  };
}

export { validateContextUsage, validateRawCategoryKinds, FixtureError };
