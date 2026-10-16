// Migration planner for parent-given names (#385, vague #380). Pure: no Electron, no node:*, no I/O.
// Decides, per workspace, what the one-shot migration does; scripts/migrate-parent-names.mjs gathers the inputs
// (store, git, running vagues) and applies each `rename` step through the installed app's CLI — never by editing store.json.
import type { Workspace } from './types.ts';
import { canOrchestrate } from './types.ts';
import { checkSpawnName } from './naming-policy.ts';

/** The Workspace fields the planner reads. */
export type MigrationWorkspace = Pick<
  Workspace,
  'id' | 'branch' | 'parentId' | 'namedByParent' | 'branchManuallySet' | 'archived' | 'kind' | 'canOrchestrate' | 'host'
>;

/** One row of the human-validated table. `old` (optional, recommended) is the branch the human validated the row
 *  against: a row whose workspace was renamed since is rejected as stale instead of applied blind. */
export interface TableRow {
  id: string;
  old?: string;
  new: string;
}

export interface MigrationInputs {
  workspaces: readonly MigrationWorkspace[];
  /** Branch names present on `origin` (union over the repos of the table's workspaces — can only over-skip). */
  remoteBranches: ReadonlySet<string>;
  /** Local branch names of those repos (the app suffixes a collision silently; the planner rejects it instead). */
  localBranches: ReadonlySet<string>;
  /** Workspace ids that belong to a vague still running — see {@link activeVagueMemberIds}. */
  activeVagueMembers: ReadonlySet<string>;
  table: readonly TableRow[];
  /** Optional git ref-format check (the script runs `git check-ref-format --branch`): an error string = git would refuse the name. */
  refFormatError?: (name: string) => string | undefined;
}

export type RowAction =
  | 'rename'
  | 'skip-remote' // current branch exists on origin: references to it would break
  | 'skip-vague' // member of a vague still running: a sibling may gate it by name
  | 'done' // already carries the table's name (idempotent re-run)
  | 'untouched-human' // nothing records an agent spawner and the table does not name it
  | 'untouched-no-parent' // in the table, but no parent/namer to apply the rename AS (D2)
  | 'untouched-not-in-table'
  | 'untouched-archived' // the app refuses to rename an archived workspace ("unknown workspace")
  | 'row-rejected'; // its table row is in `rejected`

export interface PlanRow {
  id: string;
  branch: string;
  action: RowAction;
  /** The target name (sanitised by checkSpawnName) when the workspace has a valid table row. */
  to?: string;
  /** `rename` only: the workspace id the script asserts as ORCHESTRA_WS_ID (D2: the spawner / namer). */
  asParent?: string;
  /** One line for the human. */
  reason: string;
}

export type RejectCode =
  | 'unknown-workspace'
  | 'duplicate-row'
  | 'human-pinned'
  | 'invalid-name'
  | 'stale-old'
  | 'duplicate-target'
  | 'name-taken'
  | 'invalid-ref';

export interface RejectedRow {
  /** Index in the table (0-based). */
  index: number;
  id: string;
  new: string;
  code: RejectCode;
  detail: string;
}

export interface MigrationPlan {
  rows: PlanRow[];
  rejected: RejectedRow[];
  /** The steps to apply, in store order — exactly the `rename` rows. Empty after a full apply. */
  renames: Array<{ id: string; from: string; to: string; asParent: string }>;
}

/** The label a human reads for an action (the ticket's vocabulary). */
export const ACTION_LABEL: Record<RowAction, string> = {
  rename: 'rename',
  'skip-remote': 'skip (branch on origin)',
  'skip-vague': 'skip (active vague)',
  done: 'done (already named)',
  'untouched-human': 'untouched (human-created)',
  'untouched-no-parent': 'untouched (no parent to name it)',
  'untouched-not-in-table': 'untouched (not in table)',
  'untouched-archived': 'untouched (archived)',
  'row-rejected': 'rejected (see table errors)',
};

/**
 * Ids of the workspaces that belong to a vague still running: for each live VAGUE anchor — a live orchestrator
 * that has a parent (bus-run-anchor.ts: `parentRunId === null ? 'mission' : 'vague'`) — the anchor itself and
 * everything below it. "Live" is the app's own rule (`liveFleetRuns`, pause-memory.ts): the anchor is not archived
 * (nor sandbox-hosted) AND at least one live local workspace sits below it. Nothing writes `runs.closed_at`, so the
 * store is the whole truth. The app has no "close" event, and archiving an orchestrator archives its WHOLE subtree
 * (archiveWorkspace), after which the app refuses every rename — so the operator DECLARES a finished-but-live vague
 * through `closed` (anchor ids): its members leave the set while they are still renamable. A top-level orchestrator is a
 * mission (not a vague): its workers are never held — leave them out of the table to keep their names.
 */
export function activeVagueMemberIds(
  workspaces: readonly Pick<Workspace, 'id' | 'parentId' | 'archived' | 'kind' | 'canOrchestrate' | 'host'>[],
  closed: ReadonlySet<string> = new Set(),
): Set<string> {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const live = (w: { archived?: boolean; host?: { kind: string } }): boolean => !w.archived && w.host?.kind !== 'sandbox';
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let cur = byId.get(id)?.parentId;
    while (cur && !seen.has(cur) && byId.has(cur)) {
      out.push(cur);
      seen.add(cur);
      cur = byId.get(cur)!.parentId;
    }
    return out;
  };
  const hasLiveBelow = new Set<string>();
  for (const w of workspaces) if (live(w)) for (const a of ancestors(w.id)) hasLiveBelow.add(a);
  const members = new Set<string>();
  for (const a of workspaces) {
    if (!canOrchestrate(a) || !live(a) || !hasLiveBelow.has(a.id) || closed.has(a.id)) continue;
    if (!a.parentId || !byId.has(a.parentId)) continue; // a top-level orchestrator runs a mission, not a vague
    members.add(a.id);
    for (const w of workspaces) if (ancestors(w.id).includes(a.id)) members.add(w.id);
  }
  return members;
}

/** Plan the migration. Pure and idempotent: feed it the store AFTER an apply and `renames` is empty. */
export function planMigration(input: MigrationInputs): MigrationPlan {
  const byId = new Map(input.workspaces.map((w) => [w.id, w]));
  const rejected: RejectedRow[] = [];
  const valid = new Map<string, { index: number; to: string; drift?: string }>(); // workspace id → its accepted row (+ the `old` it drifted from, if any)

  // Table-level facts used by the per-row checks.
  const idCount = new Map<string, number>();
  for (const r of input.table) idCount.set(r.id, (idCount.get(r.id) ?? 0) + 1);
  const checks = input.table.map((r) => checkSpawnName(r.new));
  // Only rows whose workspace is LIVE can be applied, so only they compete for a target name (a row of a pruned or archived workspace never lands).
  const targetCount = new Map<string, number>();
  input.table.forEach((r, i) => {
    const c = checks[i];
    const w = byId.get(r.id);
    if (c.ok && w && !w.archived) targetCount.set(c.name, (targetCount.get(c.name) ?? 0) + 1);
  });
  // Names a rename cannot land on: a branch of the repos, or the current branch of another LIVE workspace.
  const taken = new Set<string>([...input.remoteBranches, ...input.localBranches]);
  for (const w of input.workspaces) if (!w.archived) taken.add(w.branch);
  // git refs are files: `a` cannot coexist with `a/b` (either way round), so a path-prefix clash counts as taken.
  const clash = (to: string, own: string): string | undefined => {
    for (const t of taken) if (t !== own && (t === to || t.startsWith(`${to}/`) || to.startsWith(`${t}/`))) return t;
    return undefined;
  };

  input.table.forEach((r, index) => {
    const reject = (code: RejectCode, detail: string): void => {
      rejected.push({ index, id: r.id, new: r.new, code, detail });
    };
    const ws = byId.get(r.id);
    if (!ws) return reject('unknown-workspace', 'no workspace with this id in the store');
    if ((idCount.get(r.id) ?? 0) > 1) return reject('duplicate-row', 'the id appears more than once in the table');
    const check = checks[index];
    if (!check.ok) return reject('invalid-name', check.error);
    const to = check.name;
    // An ARCHIVED workspace is never renamed (the app refuses): its row is only checked for being well-formed, so it cannot block a run.
    if (ws.archived) {
      valid.set(r.id, { index, to });
      return;
    }
    if (ws.branchManuallySet === true) return reject('human-pinned', `a human named it (${ws.branch}) — a human rename wins for good`);
    // `old` is a cross-check, the id is the identity. A legacy child that is NOT parent-named renames ITSELF while its nudge is active (and may win a race against this very
    // run), so its name drifting from `old` is expected and the row still applies. Once someone parent-named it differently the table is outdated: that refuses.
    const drifted = r.old !== undefined && r.old !== ws.branch && ws.branch !== to;
    if (drifted && ws.namedByParent) {
      return reject('stale-old', `the table was validated against "${r.old}" but it has been parent-named "${ws.branch}" since`);
    }
    const refError = input.refFormatError?.(to);
    if (refError) return reject('invalid-ref', refError);
    if ((targetCount.get(to) ?? 0) > 1) return reject('duplicate-target', `another row targets the same name "${to}"`);
    const clashing = ws.branch === to ? undefined : clash(to, ws.branch);
    if (clashing) return reject('name-taken', `"${to}" conflicts with the existing branch / workspace name "${clashing}"`);
    valid.set(r.id, { index, to, ...(drifted ? { drift: r.old } : {}) });
  });

  const rejectedIds = new Set(rejected.map((x) => x.id));
  const rows: PlanRow[] = [];
  for (const ws of input.workspaces) {
    const base = { id: ws.id, branch: ws.branch };
    const row = valid.get(ws.id);
    if (!row) {
      if (rejectedIds.has(ws.id)) rows.push({ ...base, action: 'row-rejected', reason: 'its table row is rejected' });
      else if (!ws.parentId && !ws.namedByParent) rows.push({ ...base, action: 'untouched-human', reason: 'no recorded spawner' });
      else rows.push({ ...base, action: 'untouched-not-in-table', reason: 'no table row' });
      continue;
    }
    const to = row.to;
    if (ws.archived) {
      rows.push({ ...base, action: 'untouched-archived', to, reason: 'archived: the app refuses to rename it' });
      continue;
    }
    // Already carrying the name AND already parent-named: nothing left to do. Carrying the name but NOT parent-named (a self-chosen name, or a rename a
    // pre-#383 app did not pin) stays a `rename` to the same name: the app persists the pin on a same-name rename (pinAdvancesGate) — a no-op for git.
    if (ws.branch === to && ws.namedByParent) {
      rows.push({ ...base, action: 'done', to, reason: 'already named' });
      continue;
    }
    // D2: the rename is applied AS the parent (self-asserted ORCHESTRA_WS_ID): `parentId`, else the namer. The app compares ids only (decideRename), so a parent
    // that has since left the store still names its child — an id that exists is preferred; with neither recorded there is nobody to name it.
    const ids = [ws.parentId, ws.namedByParent].filter((p): p is string => !!p);
    const asParent = ids.find((p) => byId.has(p)) ?? ids[0];
    if (!asParent) {
      rows.push({ ...base, action: 'untouched-no-parent', to, reason: 'no parentId/namedByParent recorded — rename it from the sidebar or re-attach it' });
      continue;
    }
    if (input.remoteBranches.has(ws.branch)) {
      rows.push({ ...base, action: 'skip-remote', to, reason: `"${ws.branch}" exists on origin` });
      continue;
    }
    if (input.activeVagueMembers.has(ws.id)) {
      rows.push({ ...base, action: 'skip-vague', to, reason: 'member of a vague still running — re-run at its close' });
      continue;
    }
    const gone = byId.has(asParent) ? '' : ' (no longer in the store)';
    const pinOnly = ws.branch === to ? ' · pin only, the name is already right' : '';
    const drift = row.drift !== undefined ? ` · it renamed itself since the table (was "${row.drift}")` : '';
    rows.push({ ...base, action: 'rename', to, asParent, reason: `as ${asParent.slice(0, 8)}${gone}${pinOnly}${drift}` });
  }

  const renames = rows
    .filter((r) => r.action === 'rename')
    .map((r) => ({ id: r.id, from: r.branch, to: r.to!, asParent: r.asParent! }));
  return { rows, rejected, renames };
}

/** The printable plan: one line per workspace that has something to say, then the rejected rows, then totals. */
export function renderPlan(plan: MigrationPlan, opts: { verbose?: boolean; allowGone?: boolean } = {}): string[] {
  const lines: string[] = [];
  const quiet = new Set<RowAction>(opts.verbose ? [] : ['untouched-human', 'untouched-not-in-table', 'done']);
  for (const r of plan.rows) {
    if (quiet.has(r.action)) continue;
    const arrow = r.to ? `${r.branch} -> ${r.to}` : r.branch;
    lines.push(`PLAN  ${r.id.slice(0, 8)}  ${ACTION_LABEL[r.action].padEnd(34)}  ${arrow}  [${r.reason}]`);
  }
  // `allowGone`: a row of a workspace that no longer exists (pruned after its merge) is reported, not an error.
  const gone = (x: RejectedRow): boolean => !!opts.allowGone && x.code === 'unknown-workspace';
  for (const x of plan.rejected) {
    if (gone(x)) lines.push(`GONE  row ${x.index + 1}  ${x.id.slice(0, 8)}  "${x.new}"  [the workspace no longer exists — nothing to do]`);
    else lines.push(`REJECTED  row ${x.index + 1}  ${x.id.slice(0, 8)}  ${x.code}  "${x.new}"  [${x.detail}]`);
  }
  const count = (a: RowAction): number => plan.rows.filter((r) => r.action === a).length;
  lines.push(
    `TOTAL  ${plan.rows.length} workspace(s): ${count('rename')} rename · ${count('skip-remote')} skip(origin) · ${count('skip-vague')} skip(vague) · ` +
      `${count('done')} done · ${count('untouched-no-parent')} no-parent · ${count('untouched-archived')} archived · ` +
      `${count('untouched-human')} human-created · ${count('untouched-not-in-table')} not-in-table · ${plan.rejected.filter((x) => !gone(x)).length} rejected row(s)` +
      `${plan.rejected.some(gone) ? ` · ${plan.rejected.filter(gone).length} gone` : ''}`,
  );
  return lines;
}
