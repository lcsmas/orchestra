// #515 — the HOST half of the forced acceptance flow (the `/fanoutAcceptance` socket route): spawn the ticket's `accept-` writer, post the freeze status. Pure of Electron: the app's spawn
// and bus come in as `deps` (src/main/fanout-acceptance-wiring.ts), so the rig and the tests drive this very function. Decisions on the state: src/shared/fanout-acceptance.ts.
import {
  FanoutStateError, assertRunId, readState, stateFile, updateState, type FanoutState,
} from './fanout-state.ts';
import { readRepoFacts } from './fanout-harness-facts.ts';
import { resolveHarness, type RepoFacts, type ResolvedHarness } from './fanout-harness.ts';
import { acceptanceBranch, acceptorBrief, acceptorName, amendedStatusText, claimAcceptor, frozenRecipients, frozenStatusText, settleAcceptor } from './fanout-acceptance.ts';

export interface AcceptanceHostDeps {
  home: string;
  now: () => string;
  /** Does `id` name a live workspace? (the run's coordinator owns the writer; an unknown run id falls back to the caller.) */
  isWorkspace: (id: string) => boolean;
  /** The checkout the writer works in: the ticket's implementer's repo, else the repo matching the state's `owner/name`, else the caller's. undefined = let the spawn inherit. */
  repoPath: (i: { run: string; ticket: string; from?: string; repo: string | null; implementer: string | null }) => string | undefined;
  /** The agent spawn route (`dispatchAgentSpawnRequest`): the role table pins the model from the name's `accept-` prefix. */
  spawn: (i: { from?: string; name: string; task: string; repoPath?: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  /** #538 — the facts the harness discovery reads, from the TARGET ref of the repo at `repoPath` (null = cannot inspect). Default: git on that path (fanout-harness-facts.ts). */
  repoFacts?: (repoPath: string | undefined, target: string) => RepoFacts | null;
  /** #554 (review T3 m1) — the workspaces the run's owner spawned (direct children): the bus/host-side first-spawn signal, beside the state-side one. Absent = none known. */
  childrenOf?: (run: string) => string[];
  /** #554 — re-render the verified-fanout skill of these workspaces from their run's switches (the coordinator that just set them reads the text without a restart). Absent = nothing to refresh. */
  refreshSkills?: (ids: string[]) => Promise<string[]>;
  /** Post a bus status to `to` (in ITS run); throws when it cannot. */
  post: (i: { to: string; sender: string; body: string }) => void;
}

export type AcceptanceHostResult =
  | { ok: true; op: 'spawn'; id: string; name: string }
  | { ok: true; op: 'skills'; refreshed: string[] }
  | { ok: true; op: 'children'; children: string[] }
  | { ok: true; op: 'frozen' | 'amended'; notified: string[]; failed: Array<{ id: string; error: string }>; note?: string }
  | { ok: false; error: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** #538 — DECLARED in the state, else DISCOVERED on the target ref (never the implementer's worktree), else none. The facts are only read when nothing is declared; a failed read never blocks the spawn. */
function harnessFor(state: FanoutState, repoPath: string | undefined, deps: AcceptanceHostDeps): ResolvedHarness {
  const declared = resolveHarness(state.harness, null);
  if (declared.source === 'declared') return declared;
  let facts: RepoFacts | null = null;
  try { facts = (deps.repoFacts ?? readRepoFacts)(repoPath, state.target); } catch { /* unreadable = not inspected */ }
  return resolveHarness(null, facts);
}

export async function dispatchFanoutAcceptance(input: Record<string, unknown>, deps: AcceptanceHostDeps): Promise<AcceptanceHostResult> {
  try {
    const run = assertRunId(str(input.run) ?? '');
    if (input.op === 'children') { // #554 (review T3 delta m1): a custom `--run <id>` is no workspace — its owner is the caller (`from`)
      const owner = deps.isWorkspace(run) ? run : (str(input.from) && deps.isWorkspace(str(input.from)!) ? str(input.from)! : null);
      return { ok: true, op: 'children', children: owner && deps.childrenOf ? deps.childrenOf(owner) : [] };
    }
    if (input.op === 'skills') { // #554: `state init|set --switch` asks the host to re-render the caller's (and the run owner's) skill from the switches it just wrote
      const ids = [...new Set([str(input.from), deps.isWorkspace(run) ? run : undefined].filter((x): x is string => !!x && deps.isWorkspace(x)))];
      return { ok: true, op: 'skills', refreshed: deps.refreshSkills ? await deps.refreshSkills(ids) : [] };
    }
    const ticket = str(input.ticket);
    if (!ticket) return { ok: false, error: 'missing ticket' };
    const from = str(input.from);
    const file = stateFile(deps.home, run);
    if (input.op === 'spawn') {
      const name = acceptorName(ticket);
      // Claim the slot under the state lock BEFORE spawning: two concurrent `state set` calls spawn ONE writer.
      let spec = '';
      const claimed = updateState(file, (cur) => {
        if (!cur) throw new FanoutStateError(`no fanout state for run ${run}`);
        const next = claimAcceptor(cur, ticket, name, deps.now(), { replace: input.replace === true });
        spec = next.tickets[ticket].spec ?? '';
        return next;
      });
      const t = claimed.tickets[ticket];
      const parent = deps.isWorkspace(run) ? run : from;
      // the writer exists once the spawn answered: losing its id (a lock timeout…) would strand the ticket, so the write is retried
      const settle = (r: { id: string } | { error: string }): void => {
        for (let k = 0; ; k++) {
          try { updateState(file, (cur) => (cur ? settleAcceptor(cur, ticket, r, deps.now()) : cur as never)); return; } catch (e) { if (k >= 3) throw e; }
        }
      };
      let res: Awaited<ReturnType<AcceptanceHostDeps['spawn']>>;
      try {
        const repoPath = deps.repoPath({ run, ticket, from, repo: claimed.repo, implementer: t.implementer });
        const task = acceptorBrief({ run, ticket, spec, repo: claimed.repo, target: claimed.target, harness: harnessFor(claimed, repoPath, deps) });
        res = await deps.spawn({ ...(parent ? { from: parent } : {}), name, task, repoPath });
      } catch (e) {
        res = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (!res.ok || !res.id) { const error = res.error ?? 'spawn failed'; settle({ error }); return { ok: false, error: `could not spawn the writer: ${error}` }; }
      settle({ id: res.id });
      return { ok: true, op: 'spawn', id: res.id, name };
    }
    if (input.op === 'frozen' || input.op === 'amended') {
      const state = readState(file);
      const t = state?.tickets[ticket];
      if (!state || !t) return { ok: false, error: `ticket ${ticket} is not in the fanout state of run ${run}` };
      if (!t.acceptance) return { ok: false, error: `${ticket}: nothing is frozen yet` };
      const writer = t.accept?.acceptor?.id ?? null;
      const retro = Array.isArray(input.to) ? (input.to as unknown[]).filter((x): x is string => typeof x === 'string') : null; // a recipient recorded after the freeze: the recorded status goes to those ids only
      if (!retro && from && from !== writer && from !== run) return { ok: false, error: `${from} is neither ${ticket}'s writer nor the run's coordinator: the freeze status is not posted on its word` };
      const last = t.acceptance.amendments.at(-1);
      const where = { run, ticket, files: Object.keys(t.acceptance.files), branch: t.acceptance.source.branch ?? acceptanceBranch(run), head: t.acceptance.source.head };
      const body = input.op === 'amended' && last?.kind === 'harness-only' ? amendedStatusText({ ...where, reason: last.reason }) : frozenStatusText({ ...where, runCmd: t.acceptance.run });
      const to = frozenRecipients(t, writer).filter((id) => !retro || retro.includes(id));
      const notified: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const id of to) {
        try { deps.post({ to: id, sender: from ?? run, body }); notified.push(id); } catch (e) { failed.push({ id, error: e instanceof Error ? e.message : String(e) }); }
      }
      return { ok: true, op: input.op, notified, failed, ...(to.length === 0 ? { note: `no --implementer / --verifier recorded on ${ticket} (state set ${ticket} --implementer <id> --verifier <id>): nobody was told` } : {}) };
    }
    return { ok: false, error: `unknown op ${JSON.stringify(input.op)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
