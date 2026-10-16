// Naming policy (#380) — the single source of the workspace-naming rule. Pure: no Electron, no node:*.
// INTERFACE FREEZE (OPS, vague #380): signatures + docs are FROZEN in the ledger; bodies marked STUB are
// filled by the owning ticket (#381 today's rule, #382 spawn name, #383 authority). Do not change a signature
// without a "what changed" line on the ledger.
import type { Workspace } from './types.ts';

/** Rôle prefixes of a spawned agent's name (CONTEXT.md "Rôle"). */
export const ROLES = ['ops', 'impl', 'verif', 'review', 'explo'] as const;
export type Role = (typeof ROLES)[number];

/** The convention, restated verbatim by every refusal / help / skill. Owned by #382. */
export const NAME_CONVENTION =
  "<rôle>-<objet en mots humains>[-<ticket>] — rôle ∈ ops | impl | verif | review | explo (ex. impl-politique-nommage-381)";

/** The agent may auto-rename its own branch this many times before the nudge retires. Moved here by #381. */
export const MAX_AUTO_RENAMES = 2;

/** Branch-name allow-list (moved verbatim from workspaces.ts by #381). */
export function sanitizeBranchName(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._/-]/g, '').slice(0, 80);
}

/** The Workspace fields the policy reads. */
export type NamingFields = Pick<Workspace, 'branchManuallySet' | 'autoRenameCount' | 'namedByParent' | 'parentId'>;

// ── #381 (today's rule, no behaviour change) ────────────────────────────────

/** Is the rename nudge still active? #381: `!branchManuallySet && (autoRenameCount ?? 0) < MAX_AUTO_RENAMES`
 *  (today's `autoRenameActive`). #382 adds `&& !namedByParent`. The nudge hook's `ORCHESTRA_BRANCH_AUTO` reads ONLY this. */
export function nudgeActive(_ws: NamingFields): boolean {
  throw new Error('naming-policy.nudgeActive: STUB — implemented by #381');
}

/** Naming fields of a freshly created workspace: `{ branchManuallySet: false }`, plus `namedByParent: namedBy` when
 *  an agent named it at spawn (#382). `createWorkspace` spreads this — no inline `branchManuallySet: false` stays. */
export function initialNaming(_opts?: { namedBy?: string }): Pick<Workspace, 'branchManuallySet' | 'namedByParent'> {
  throw new Error('naming-policy.initialNaming: STUB — implemented by #381');
}

// ── #382 (spawn-name check) ─────────────────────────────────────────────────

export type SpawnNameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Required; sanitised with {@link sanitizeBranchName}; must start with `<rôle>-` (rôle ∈ {@link ROLES}) and carry
 *  something after it; the error restates {@link NAME_CONVENTION}. Used by the CLI (before the socket) AND the /spawn route. */
export function checkSpawnName(_raw: string | undefined | null): SpawnNameCheck {
  throw new Error('naming-policy.checkSpawnName: STUB — implemented by #382');
}

// ── #381 shape, #383 matrix (rename authority) ──────────────────────────────

/** Who asks for the rename. `human` = the sidebar UI (api-handlers `renameBranch`).
 *  `agent` = the socket `/rename`; `id` = the caller's `from` (ORCHESTRA_WS_ID), absent = unknown caller. */
export type RenameCaller = { kind: 'human' } | { kind: 'agent'; id?: string };

/** What the rename pins when allowed. `manual` ⇒ `branchManuallySet = true` (human pin); `bumpAutoCount` ⇒
 *  `autoRenameCount + 1`; `namedByParent` ⇒ set the field to that parent id (#383). */
export interface RenamePin {
  manual: boolean;
  bumpAutoCount: boolean;
  namedByParent?: string;
}

export type RenameDecision = { allow: true; pin: RenamePin } | { allow: false; error: string };

/** `target` = the workspace being renamed (its `id` + naming fields + `parentId` + display `branch`).
 *  #381 = today's rule: `human` → `{manual:true, bumpAutoCount:false}`; any `agent` → `{manual:false,
 *  bumpAutoCount:nudgeActive(target)}`; never refused. #383 replaces the agent arm with the human > parent > child matrix. */
export function decideRename(
  _target: NamingFields & { id: string; branch: string },
  _caller: RenameCaller,
): RenameDecision {
  throw new Error('naming-policy.decideRename: STUB — implemented by #381 (today) / #383 (matrix)');
}
