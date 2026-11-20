// #480 (closes #477): the ONE place that decides which Claude account a NEW child workspace is pinned to. Pure — no store/fs/electron.
// Every child-creating path reaches it through `createWorkspace` (workspaces.ts); grep gate scripts/check-spawn-account-single-resolver.mjs.
import type { Account } from './accounts.ts';

export type ChildAccountSource = 'explicit' | 'explicit-default' | 'caller' | 'repo' | 'default';

export type ChildAccountDecision =
  | { ok: true; accountId: string | undefined; source: ChildAccountSource }
  | { ok: false; error: string };

/** Precedence: an explicit `--account` (id or label; `default` = the default login) > the CALLER's pinned account (when it still names a
 *  configured one) > the repo's assigned account > the default login (`accountId` undefined). A caller on the default login, or pinned to a deleted
 *  account, falls through to the repo's account — today's behaviour, so no spawn that worked before changes. An unknown explicit value is refused
 *  (the caller creates nothing). */
export function resolveChildAccount(input: {
  explicit?: string | null;
  callerAccountId?: string | null;
  repoAccountId?: string | null;
  accounts: ReadonlyArray<Pick<Account, 'id' | 'label'>>;
}): ChildAccountDecision {
  const known = new Set(input.accounts.map((a) => a.id));
  const wanted = (input.explicit ?? '').trim();
  if (wanted) {
    if (known.has(wanted)) return { ok: true, accountId: wanted, source: 'explicit' };
    if (wanted.toLowerCase() === 'default') return { ok: true, accountId: undefined, source: 'explicit-default' }; // the keyword beats a LABEL "Default" (an id `default` matched above)
    const byLabel = input.accounts.filter((a) => a.label.trim().toLowerCase() === wanted.toLowerCase());
    if (byLabel.length === 1) return { ok: true, accountId: byLabel[0].id, source: 'explicit' };
    const list = input.accounts.map((a) => a.id).join(', ') || 'none configured';
    return {
      ok: false,
      error: `${byLabel.length > 1 ? 'ambiguous' : 'unknown'} account: ${JSON.stringify(wanted.slice(0, 80))} (ids: ${list}; \`orchestra accounts\` lists them, \`default\` = the default login)`,
    };
  }
  const caller = (input.callerAccountId ?? '').trim();
  if (caller && known.has(caller)) return { ok: true, accountId: caller, source: 'caller' };
  const repo = (input.repoAccountId ?? '').trim();
  if (repo) return { ok: true, accountId: repo, source: 'repo' };
  return { ok: true, accountId: undefined, source: 'default' };
}

/** The first-turn failure `Not logged in · Please run /login` (the child's account has no usable login): append ONE line naming the fix command.
 *  '' for any other failure. `accountId` = what the child is pinned to (undefined = default login). */
export function loginFailureHint(input: {
  reason: string;
  workspaceId: string;
  accountId?: string;
  accounts: ReadonlyArray<Pick<Account, 'id' | 'label'>>;
}): string {
  if (!/not logged in|please run \/login/i.test(input.reason)) return '';
  const label = input.accountId ? input.accounts.find((a) => a.id === input.accountId)?.label ?? input.accountId : 'the default login';
  return (
    ` The child runs on ${label}, which has no usable login: log that account in (Settings > Accounts) or move the child to a logged-in one with ` +
    `\`orchestra migrate-account ${input.workspaceId} <account>\` (\`orchestra accounts\` lists them).`
  );
}
