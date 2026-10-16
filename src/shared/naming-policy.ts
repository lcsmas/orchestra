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
 *  (today's `autoRenameActive`), `&& !namedByParent` (#382: a child named by its parent is never nudged). The nudge hook's `ORCHESTRA_BRANCH_AUTO` reads ONLY this. */
export function nudgeActive(ws: NamingFields): boolean {
  return !ws.branchManuallySet && !ws.namedByParent && (ws.autoRenameCount ?? 0) < MAX_AUTO_RENAMES;
}

/** Naming fields of a freshly created workspace: `{ branchManuallySet: false }`, plus `namedByParent: namedBy` when
 *  an agent named it at spawn (#382). `createWorkspace` spreads this — no inline `branchManuallySet: false` stays. */
export function initialNaming(opts?: { namedBy?: string }): Pick<Workspace, 'branchManuallySet' | 'namedByParent'> {
  return { branchManuallySet: false, ...(opts?.namedBy ? { namedByParent: opts.namedBy } : {}) };
}

// ── #382 (spawn-name check) ─────────────────────────────────────────────────

export type SpawnNameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Longest accepted spawn name: {@link sanitizeBranchName} cuts at 80, and a silently cut name loses its `-<ticket>` tail. */
const MAX_SPAWN_NAME = 79;

/** Required; diacritics folded (`réglages` → `reglages`, never dropped), then sanitised with {@link sanitizeBranchName}; must
 *  start with `<rôle>-` (rôle ∈ {@link ROLES}) and carry something after it; flat (no `/`), under {@link MAX_SPAWN_NAME}
 *  characters and a valid git branch name; every error restates {@link NAME_CONVENTION}. Used by the CLI (before the
 *  socket) AND the /spawn route. */
export function checkSpawnName(raw: string | undefined | null): SpawnNameCheck {
  const refuse = (why: string): SpawnNameCheck => ({ ok: false, error: `${why} — expected ${NAME_CONVENTION}` });
  const given = typeof raw === 'string' ? raw.trim() : '';
  if (!given) return refuse('a spawn needs a name (--name): none given');
  // The convention asks for words in the human's language: sanitizeBranchName would DROP an accented letter (réglages → rglages),
  // and an NFC vs NFD input would then differ. Fold first (NFD + strip marks, plus the few letters that do not decompose).
  const folded = given
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[œŒæÆß]/g, (c) => ({ œ: 'oe', Œ: 'Oe', æ: 'ae', Æ: 'Ae', ß: 'ss' })[c] ?? c);
  const name = sanitizeBranchName(folded);
  if (!name) return refuse(`name "${given}" has no usable character (letters, digits, . _ - only)`);
  const role = ROLES.find((r) => name.startsWith(`${r}-`));
  if (!role) return refuse(`name "${name}" does not start with a rôle`);
  if (!/[a-zA-Z0-9]/.test(name.slice(role.length + 1))) return refuse(`name "${name}" names the rôle but not the work`);
  if (name.includes('/')) return refuse(`name "${name}" contains "/" — a spawn name is flat, no folders`);
  if (name.length > MAX_SPAWN_NAME) return refuse(`name "${name.slice(0, 40)}…" is too long (${MAX_SPAWN_NAME} characters max — a cut name would lose its ticket)`);
  if (/\.\.|\.$|\.lock$/.test(name)) return refuse(`name "${name}" is not a valid git branch name (no "..", no trailing "." or ".lock")`);
  return { ok: true, name };
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

/** Facts the policy cannot read off the target: the DISPLAY NAME of the namer (the caller looks it up from
 *  `parentId ?? namedByParent`), put in the refusal so the child knows whom to ask. Additive optional arg (#383). */
export interface RenameContext {
  parentName?: string;
}

/** Why a rename is refused — the texts the child / parent / other agent reads (CLI prints them verbatim). */
export function namedByParentRefusal(parentName?: string): string {
  return `named by your parent${parentName ? ` (${parentName})` : ''} — ask them to run \`orchestra rename\``;
}
export const NAMED_BY_HUMAN_REFUSAL = 'named by the human — the name is pinned, only the human can change it';

/** `target` = the workspace being renamed (its `id` + naming fields + `parentId` + display `branch`).
 *  Authority human > parent > child (#383, D5 — behaviour frozen in ledger #387). Target states: U unnamed (no
 *  `namedByParent`, no human pin: human-created or legacy agent), P named by parent (`namedByParent`), H human-pinned
 *  (`branchManuallySet`). "Parent" = `caller.id` is the target's `parentId` or its `namedByParent` (a `--detached`
 *  child has no `parentId`); an absent/empty caller id is an UNKNOWN caller, never a parent.
 *   · human            → always allowed; pins `manual`; `namedByParent` untouched (not in the pin).
 *   · H + `namedByParent` set, or H + the target's parent (D6) → agent refused ("named by the human"): a human rename
 *     pins for everyone, parent included.
 *   · H, no `namedByParent`, caller not the parent → human-created / legacy workspace: allowed as today (nudge off, no bump).
 *   · P + parent       → allowed, stays P, no counter bump.   · P + self/other/unknown → refused (ask your parent).
 *   · U + parent       → allowed, pins P (`namedByParent` = caller id), no counter bump.
 *   · U + self/other/unknown → allowed exactly as today: counter bump while {@link nudgeActive}. */
export function decideRename(
  target: NamingFields & { id: string; branch: string },
  caller: RenameCaller,
  ctx: RenameContext = {},
): RenameDecision {
  if (caller.kind === 'human') return { allow: true, pin: { manual: true, bumpAutoCount: false } };
  const namer = target.namedByParent || undefined;
  const isParent = !!caller.id && (caller.id === target.parentId || caller.id === namer);
  if (target.branchManuallySet) {
    if (namer || isParent) return { allow: false, error: NAMED_BY_HUMAN_REFUSAL };
    return { allow: true, pin: { manual: false, bumpAutoCount: nudgeActive(target) } };
  }
  if (namer) {
    if (isParent) return { allow: true, pin: { manual: false, bumpAutoCount: false, namedByParent: namer } };
    return { allow: false, error: namedByParentRefusal(ctx.parentName) };
  }
  if (isParent) return { allow: true, pin: { manual: false, bumpAutoCount: false, namedByParent: caller.id } };
  return { allow: true, pin: { manual: false, bumpAutoCount: nudgeActive(target) } };
}

/** What an OUT-OF-BAND `git branch -m` pins (activity.ts `detectAndUpdateBranchName` adopts the live branch whoever ran it). The name
 *  already changed in git, so it is adopted — but a rename that bypassed `/rename` must not confer the HUMAN's authority on a
 *  parent-named workspace (a refused child could `git branch -m` and lock its parent out): P and not yet human-pinned → no pin, the
 *  parent can still rename it (the human uses the sidebar). Anywhere else: today's — a human pin. Additive export (#383). */
export function adoptedBranchPin(target: NamingFields): RenamePin {
  if (target.namedByParent && !target.branchManuallySet) return { manual: false, bumpAutoCount: false };
  return { manual: true, bumpAutoCount: false };
}

/** Does `pin` change anything on `ws`? A rename to the SAME name still has to persist the pin when it does (a first human
 *  pin, a counted agent rename, or — #383 — a parent's first pin: `namedByParent` differs from the stored one) —
 *  `renameWorkspaceBranch`'s same-name short-circuit asks this. ADDED by #381 (additive). */
export function pinAdvancesGate(ws: NamingFields, pin: RenamePin): boolean {
  return (pin.manual && !ws.branchManuallySet) || pin.bumpAutoCount || (!!pin.namedByParent && pin.namedByParent !== ws.namedByParent);
}

/** The Workspace fields an allowed rename writes for `pin` (spread into the renamed record). Today: `manual` ⇒
 *  `branchManuallySet` stays/turns true; `bumpAutoCount` ⇒ `autoRenameCount + 1`; `namedByParent` ⇒ that id (#383).
 *  ADDED by #381 (additive, not a signature change): `renameWorkspaceBranch` and the human pin sites share it. */
export function pinFields(
  ws: NamingFields,
  pin: RenamePin,
): Partial<Pick<Workspace, 'branchManuallySet' | 'autoRenameCount' | 'namedByParent'>> {
  return {
    branchManuallySet: pin.manual || ws.branchManuallySet,
    ...(pin.bumpAutoCount ? { autoRenameCount: (ws.autoRenameCount ?? 0) + 1 } : {}),
    ...(pin.namedByParent ? { namedByParent: pin.namedByParent } : {}),
  };
}
