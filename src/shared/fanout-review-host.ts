// #588 (I3) — the HOST half of `orchestra fanout review` (op `review` of the `/fanoutAcceptance` route, the same host call path as the acceptance writer's spawn): decide spawn / wake / replace / nothing,
// render the brief from the state, spawn the `review-` agent nested under the run's coordinator (or wake the live one with the delta), and record who it is. Pure of Electron: deps come in.
import { FanoutStateError, assertRunId, readState, stateFile, updateState, type FanoutState } from './fanout-state.ts';
import { assertReviewable, assertReviewerRole, claimReviewer, decideReview, nthReviewer, recordWake, renderBriefOf, reviewerName, settleReviewer, undoWake, ReviewRefusal, type ReviewAction } from './fanout-review.ts';

export interface ReviewHostDeps {
  home: string;
  now: () => string;
  isWorkspace: (id: string) => boolean;
  /** Is this workspace alive (exists, not archived)? Absent = `isWorkspace`. */
  isLive?: (id: string) => boolean;
  repoPath: (i: { run: string; ticket: string; from?: string; repo: string | null; implementer: string | null }) => string | undefined;
  spawn: (i: { from?: string; name: string; task: string; repoPath?: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  post: (i: { to: string; sender: string; body: string }) => void;
  /** Production only: does `key` belong to the LIVE session of workspace `id` (the host's session-key registry, #379)? Absent = no check (tests / rigs). */
  verifyCaller?: (id: string, key: string) => 'ok' | 'superseded' | 'unregistered';
  /** I5 — the reviewer's role file, when one exists (#590). */
  reviewerSkillPath?: () => string | null;
}

export type ReviewHostResult =
  | { ok: true; op: 'review'; action: 'spawn' | 'replace'; id: string; name: string; hash: string }
  | { ok: true; op: 'review'; action: 'wake'; id: string; name: string; hash: string }
  | { ok: true; op: 'review'; action: 'noop'; id: string | null; name: string | null; note: string }
  | { ok: false; error: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export async function dispatchReview(input: Record<string, unknown>, deps: ReviewHostDeps): Promise<ReviewHostResult> {
  try {
    const run = assertRunId(str(input.run) ?? '');
    const ticket = str(input.ticket);
    const head = str(input.head);
    if (!ticket || !head) return { ok: false, error: 'missing ticket or head' };
    const base = str(input.base) ?? null;
    // the CLI's [review-caller] is not the only door: the host re-proves the caller (a member posting straight to the socket has no key of the coordinator's)
    if (deps.verifyCaller) {
      const id = str(input.callerId), key = typeof input.key === 'string' ? input.key : '';
      if (!id || id !== run || !key || deps.verifyCaller(id, key) !== 'ok') return { ok: false, error: `[review-caller] the host could not vouch that the caller is the run's coordinator (${run}): ${!id || id !== run ? 'the caller is not the run\'s coordinator' : 'its session key is not the live one'}` };
    }
    const from = str(input.from);
    const file = stateFile(deps.home, run);
    const live = deps.isLive ?? deps.isWorkspace;
    const skillPath = deps.reviewerSkillPath?.() ?? undefined;
    const now = deps.now();
    const st = readState(file);
    if (!st) return { ok: false, error: `no fanout state for run ${run}` };
    const t0 = assertReviewable(st, ticket);
    if (!t0.head || !(t0.head.startsWith(head) || head.startsWith(t0.head))) return { ok: false, error: `${ticket}: the head moved (state has ${t0.head?.slice(0, 12)}, the call said ${head.slice(0, 12)}): run \`fanout review\` again` };
    assertReviewerRole(st, t0, t0.review?.reviewer?.id ?? null);
    const act: ReviewAction = decideReview(t0, t0.head, now, live);
    if (act.action === 'noop') return { ok: true, op: 'review', action: 'noop', id: act.id, name: t0.review?.reviewer?.name ?? null, note: act.why };
    const parent = deps.isWorkspace(run) ? run : from;

    if (act.action === 'wake') {
      const rv = t0.review!.reviewer!;
      let prev: FanoutState['tickets'][string]['review'];
      let hash = '';
      let text = '';
      // record first (a second concurrent call then sees the new head and does nothing), deliver second, undo when the delivery fails
      updateState(file, (cur) => {
        if (!cur) throw new FanoutStateError(`no fanout state for run ${run}`);
        const t = assertReviewable(cur, ticket);
        const a = decideReview(t, t.head!, now, live);
        if (a.action !== 'wake') throw new ReviewRefusal('review-race', `the reviewer of ${ticket} changed meanwhile (${a.action}): run \`fanout review\` again`);
        const b = renderBriefOf(cur, ticket, { kind: 'wake', head: t.head!, base, reviewerSkillPath: skillPath });
        text = b.text; hash = b.hash; prev = t.review;
        return recordWake(cur, ticket, { head: t.head!, base, text, now });
      });
      try {
        deps.post({ to: rv.id!, sender: from ?? run, body: text });
      } catch (e) {
        updateState(file, (cur) => (cur ? undoWake(cur, ticket, prev, deps.now()) : (cur as never)));
        return { ok: false, error: `could not wake ${rv.name} (${rv.id}): ${e instanceof Error ? e.message : String(e)} — nothing was recorded; run \`fanout review\` again` };
      }
      return { ok: true, op: 'review', action: 'wake', id: rv.id!, name: rv.name, hash };
    }

    // spawn | replace: claim the slot under the state lock BEFORE spawning (two concurrent calls spawn ONE reviewer), then spawn, then settle
    const name = reviewerName(ticket, nthReviewer(t0));
    let task = '';
    let hash = '';
    const claimed = updateState(file, (cur) => {
      if (!cur) throw new FanoutStateError(`no fanout state for run ${run}`);
      const t = assertReviewable(cur, ticket);
      const a = decideReview(t, t.head!, now, live);
      if (a.action === 'noop' || a.action === 'wake') throw new ReviewRefusal('review-race', `the reviewer of ${ticket} changed meanwhile (${a.action}): run \`fanout review\` again`);
      const b = renderBriefOf(cur, ticket, { kind: a.kind, head: t.head!, base, reviewerSkillPath: skillPath });
      task = b.text; hash = b.hash;
      return claimReviewer(cur, ticket, { kind: a.kind as 'spawn' | 'replace', name, head: t.head!, base, text: b.text, now });
    });
    const settle = (r: { id: string } | { error: string }): void => {
      for (let k = 0; ; k++) {
        try { updateState(file, (cur) => (cur ? settleReviewer(cur, ticket, r, deps.now()) : (cur as never))); return; } catch (e) { if (k >= 3) throw e; }
      }
    };
    let res: Awaited<ReturnType<ReviewHostDeps['spawn']>>;
    try {
      const repoPath = deps.repoPath({ run, ticket, from, repo: claimed.repo, implementer: claimed.tickets[ticket].implementer });
      res = await deps.spawn({ ...(parent ? { from: parent } : {}), name, task, repoPath });
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!res.ok || !res.id) { const error = res.error ?? 'spawn failed'; settle({ error }); return { ok: false, error: `could not spawn the reviewer: ${error}` }; }
    try { assertReviewerRole(claimed, claimed.tickets[ticket], res.id); } catch (e) { settle({ error: e instanceof Error ? e.message : String(e) }); throw e; }
    settle({ id: res.id });
    return { ok: true, op: 'review', action: act.action, id: res.id, name, hash };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
