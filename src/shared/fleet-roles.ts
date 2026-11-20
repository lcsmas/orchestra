import { EFFORT_LEVELS } from './effort-defaults.ts';
import { isValidModelArg } from './model-defaults.ts';
import { HANDOFF_MIN_BOUND_TURNS } from './handoff.ts';

// Fleet roles (#465, verified-fanout v2 lever 1) — the ONE table of the role → model / effort / tool-policy, keyed by the `--name`
// prefix (#382). Pure: no Electron, no node:*. Interface FROZEN in ledger #471 §Interfaces item 1; #468 (role guard) builds on it.
// Strong roles pin NO model (the Settings default applies); only `scribe` (mechanical steps) pins Haiku.

/** Role = the spawn-name prefix. `scribe` is the mechanical-steps role added by #465 (D2). */
export type FleetRole = 'coordinator' | 'implementer' | 'verifier' | 'reviewer' | 'explorer' | 'scribe';

/** Every role, in table order. */
export const FLEET_ROLES: readonly FleetRole[] = ['coordinator', 'implementer', 'verifier', 'reviewer', 'explorer', 'scribe'];

/** Name prefix (without the `-`) of each role. `Object.keys` order = the {@link ROLES}-style list of the naming policy. */
export const ROLE_PREFIX: Readonly<Record<FleetRole, string>> = {
  coordinator: 'ops',
  implementer: 'impl',
  verifier: 'verif',
  reviewer: 'review',
  explorer: 'explo',
  scribe: 'scribe',
};

/** Tool policy of a role, read by the role guard (#468). */
export interface RoleTools {
  /** Tool names the role may never call (AskUserQuestion is denied to EVERY role, D6). */
  denyTools: string[];
  /** Where the role may edit files: nowhere, its own worktree, or a scratch dir only. */
  edit: 'none' | 'own-worktree' | 'scratch';
  /** Regex SOURCES (no flags) of Bash commands the role may never run. */
  bashDeny: string[];
}

export interface RoleSpec {
  role: FleetRole;
  /** `undefined` = pin nothing (Settings default); a wire model id otherwise. */
  model: string | undefined;
  /** `undefined` = pin nothing; a level of EFFORT_LEVELS otherwise. */
  effort: string | undefined;
  tools: RoleTools;
  /** #478: turns after which the host nudges the role to `orchestra handoff` (0 = off). */
  handoffBoundTurns: number;
}

/** Wire id of the cheap model (never the short alias — `unrecognized_model`). */
export const SCRIBE_MODEL = 'claude-haiku-5-5';

/** #478: the coordinator's built-in handoff bound. Replaying rts-vf2-local-1's OPS (214 turns, ~3.5 requests/turn, +2.4k tok/turn) the weighted cache cost is
 *  minimal at 14-24 turns (fresh base 60-160k tok) and flat to 40; 30 is within 1-4 points of it with fewer handoffs (docs/evidence/478-handoff-bound.txt). */
export const COORDINATOR_HANDOFF_BOUND_TURNS = 30;

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const NO_COMMIT = ['\\bgit\\s+(commit|push|merge|rebase|reset)\\b'];

const DEFAULT_TABLE: Readonly<Record<FleetRole, RoleSpec>> = {
  coordinator: { role: 'coordinator', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion', ...EDIT_TOOLS], edit: 'none', bashDeny: [] }, handoffBoundTurns: COORDINATOR_HANDOFF_BOUND_TURNS },
  implementer: { role: 'implementer', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion'], edit: 'own-worktree', bashDeny: ['\\bgit\\s+push\\b[^\\n]*\\b(master|main)\\b'] }, handoffBoundTurns: 0 },
  verifier: { role: 'verifier', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion'], edit: 'scratch', bashDeny: NO_COMMIT }, handoffBoundTurns: 0 },
  reviewer: { role: 'reviewer', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion', ...EDIT_TOOLS], edit: 'none', bashDeny: NO_COMMIT }, handoffBoundTurns: 0 },
  explorer: { role: 'explorer', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion', ...EDIT_TOOLS], edit: 'none', bashDeny: NO_COMMIT }, handoffBoundTurns: 0 },
  scribe: { role: 'scribe', model: SCRIBE_MODEL, effort: 'low', tools: { denyTools: ['AskUserQuestion', ...EDIT_TOOLS], edit: 'none', bashDeny: NO_COMMIT }, handoffBoundTurns: 0 },
};

/** Role of a spawn name (`impl-foo-12` → `implementer`), or null when the name has no role prefix. Reads the prefix
 *  as the naming policy does: `<prefix>-` at the start, case-sensitive. */
export function roleOfName(name: string | undefined | null): FleetRole | null {
  if (typeof name !== 'string') return null;
  for (const role of FLEET_ROLES) if (name.startsWith(`${ROLE_PREFIX[role]}-`)) return role;
  return null;
}

/** The spec of a role: the built-in table, with `overrides` (a {@link parseRoleConfig} result) applied on top. */
export function roleSpec(role: FleetRole, overrides?: RoleConfig): RoleSpec {
  const base = DEFAULT_TABLE[role];
  if (!base) throw new Error(`fleet-roles: no table entry for role "${String(role)}"`);
  const o = overrides?.[role];
  return {
    role,
    model: o && 'model' in o ? o.model : base.model,
    effort: o && 'effort' in o ? o.effort : base.effort,
    tools: { denyTools: [...base.tools.denyTools], edit: base.tools.edit, bashDeny: [...base.tools.bashDeny] },
    handoffBoundTurns: o && 'handoffBoundTurns' in o ? (o.handoffBoundTurns ?? 0) : base.handoffBoundTurns,
  };
}

/** Per-role override of model / effort / handoff bound (the optional `<ORCHESTRA_HOME>/fleet-roles.json`). `handoffBoundTurns: 0` = off. */
export type RoleConfig = Partial<Record<FleetRole, { model?: string; effort?: string; handoffBoundTurns?: number }>>;

const ROLE_KEYS = ['model', 'effort', 'handoffBoundTurns'] as const;

/** First object key that appears twice in the same object of a JSON text (JSON.parse is last-wins and would hide the first copy), or undefined. */
function findDuplicateKey(text: string): string | undefined {
  const stack: Array<Set<string> | null> = []; // one entry per open container: key set for an object, null for an array
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const str = text.slice(i + 1, j);
      const top = stack[stack.length - 1];
      if (expectKey && top) {
        if (top.has(str)) return str;
        top.add(str);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') { stack.push(new Set()); expectKey = true; }
    else if (c === '[') { stack.push(null); expectKey = false; }
    else if (c === '}' || c === ']') { stack.pop(); expectKey = false; }
    else if (c === ',') expectKey = stack[stack.length - 1] instanceof Set;
    i++;
  }
  return undefined;
}

/** STRICT parse of the override file's JSON text (or an already-parsed object): `{ "<role>": { "model"?, "effort"?, "handoffBoundTurns"? } }`.
 *  An unknown role, an unknown key, a wrong type or an invalid model / effort THROWS with a named error. A model of `"default"` or
 *  `null` pins nothing (clears the role's pin); a `handoffBoundTurns` of `0` / `null` / `"default"` is OFF, else an integer >= HANDOFF_MIN_BOUND_TURNS. */
export function parseRoleConfig(raw: unknown): RoleConfig {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch (e) { throw new Error(`fleet-roles config: not valid JSON (${(e as Error).message})`); }
    const dup = findDuplicateKey(raw);
    if (dup !== undefined) throw new Error(`fleet-roles config: duplicate key "${dup}" (the first copy would be silently ignored)`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('fleet-roles config: expected an object keyed by role');
  const out: RoleConfig = {};
  for (const [roleKey, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(FLEET_ROLES as readonly string[]).includes(roleKey)) {
      throw new Error(`fleet-roles config: unknown role "${roleKey}" (known: ${FLEET_ROLES.join(', ')})`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`fleet-roles config: role "${roleKey}" must be an object`);
    const slot: { model?: string; effort?: string; handoffBoundTurns?: number } = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (!(ROLE_KEYS as readonly string[]).includes(k)) throw new Error(`fleet-roles config: unknown key "${k}" in role "${roleKey}" (known: ${ROLE_KEYS.join(', ')})`);
      if (k === 'model') {
        if (v === null || v === 'default') slot.model = undefined;
        else if (typeof v === 'string' && isValidModelArg(v)) slot.model = v;
        else throw new Error(`fleet-roles config: role "${roleKey}": invalid model ${JSON.stringify(v)}`);
      } else if (k === 'handoffBoundTurns') {
        if (v === null || v === 'default' || v === 0) slot.handoffBoundTurns = 0;
        else if (typeof v === 'number' && Number.isInteger(v) && v >= HANDOFF_MIN_BOUND_TURNS) slot.handoffBoundTurns = v;
        else throw new Error(`fleet-roles config: role "${roleKey}": invalid handoffBoundTurns ${JSON.stringify(v)} (an integer >= ${HANDOFF_MIN_BOUND_TURNS}, or 0 / null / "default" = off)`);
      } else if (k === 'effort') {
        if (v === null || v === 'default') slot.effort = undefined;
        else if (typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)) slot.effort = v;
        else throw new Error(`fleet-roles config: role "${roleKey}": invalid effort ${JSON.stringify(v)} (one of ${EFFORT_LEVELS.join(', ')})`);
      }
    }
    out[roleKey as FleetRole] = slot;
  }
  return out;
}

/** What a spawn carries when `--model` / `--effort` are omitted: the role's pin (from the name prefix, then the override file), field by field.
 *  An EXPLICIT flag always wins; a role-less name or a strong role with no override returns the caller's values untouched (Settings default). */
export function resolveSpawnRoleDefaults(
  name: string | undefined | null,
  explicit: { model?: string; effort?: string },
  overrides?: RoleConfig,
): { model?: string; effort?: string } {
  const role = roleOfName(name);
  const spec = role ? roleSpec(role, overrides) : undefined;
  const model = explicit.model?.trim() ? explicit.model : spec?.model;
  const effort = explicit.effort?.trim() ? explicit.effort : spec?.effort;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** File name of the optional override, under `<ORCHESTRA_HOME>`. */
export const ROLE_CONFIG_FILE = 'fleet-roles.json';
