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
}

/** Wire id of the cheap model (never the short alias — `unrecognized_model`). */
export const SCRIBE_MODEL = 'claude-haiku-5-5';

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const NO_COMMIT = ['\\bgit\\s+(commit|push|merge|rebase|reset)\\b'];

const DEFAULT_TABLE: Readonly<Record<FleetRole, RoleSpec>> = {
  coordinator: { role: 'coordinator', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion', ...EDIT_TOOLS], edit: 'none', bashDeny: [] } },
  implementer: { role: 'implementer', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion'], edit: 'own-worktree', bashDeny: ['\\bgit\\s+push\\b[^\\n]*\\b(master|main)\\b'] } },
  verifier: { role: 'verifier', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion'], edit: 'scratch', bashDeny: NO_COMMIT } },
  reviewer: { role: 'reviewer', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion', ...EDIT_TOOLS], edit: 'none', bashDeny: NO_COMMIT } },
  explorer: { role: 'explorer', model: undefined, effort: undefined, tools: { denyTools: ['AskUserQuestion', ...EDIT_TOOLS], edit: 'none', bashDeny: NO_COMMIT } },
  scribe: { role: 'scribe', model: SCRIBE_MODEL, effort: 'low', tools: { denyTools: ['AskUserQuestion', ...EDIT_TOOLS], edit: 'none', bashDeny: NO_COMMIT } },
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
  };
}

/** Per-role override of model / effort (the optional `<ORCHESTRA_HOME>/fleet-roles.json`). */
export type RoleConfig = Partial<Record<FleetRole, { model?: string; effort?: string }>>;

const ROLE_KEYS = ['model', 'effort'] as const;
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[A-Za-z0-9._:/[\]-]{1,64}$/;

/** STRICT parse of the override file's JSON text (or an already-parsed object): `{ "<role>": { "model"?, "effort"? } }`.
 *  An unknown role, an unknown key, a wrong type or an invalid model / effort THROWS with a named error. A model of `"default"` or
 *  `null` pins nothing (clears the role's pin). */
export function parseRoleConfig(raw: unknown): RoleConfig {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch (e) { throw new Error(`fleet-roles config: not valid JSON (${(e as Error).message})`); }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('fleet-roles config: expected an object keyed by role');
  const out: RoleConfig = {};
  for (const [roleKey, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(FLEET_ROLES as readonly string[]).includes(roleKey)) {
      throw new Error(`fleet-roles config: unknown role "${roleKey}" (known: ${FLEET_ROLES.join(', ')})`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`fleet-roles config: role "${roleKey}" must be an object`);
    const slot: { model?: string; effort?: string } = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (!(ROLE_KEYS as readonly string[]).includes(k)) throw new Error(`fleet-roles config: unknown key "${k}" in role "${roleKey}" (known: ${ROLE_KEYS.join(', ')})`);
      if (k === 'model') {
        if (v === null || v === 'default') slot.model = undefined;
        else if (typeof v === 'string' && MODEL_RE.test(v)) slot.model = v;
        else throw new Error(`fleet-roles config: role "${roleKey}": invalid model ${JSON.stringify(v)}`);
      } else {
        if (v === null || v === 'default') slot.effort = undefined;
        else if (typeof v === 'string' && LEVELS.includes(v)) slot.effort = v;
        else throw new Error(`fleet-roles config: role "${roleKey}": invalid effort ${JSON.stringify(v)} (one of ${LEVELS.join(', ')})`);
      }
    }
    out[roleKey as FleetRole] = slot;
  }
  return out;
}
