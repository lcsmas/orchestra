// #589 (I4, switch seatRecords=on) — `orchestra fanout record <ticket> --head <sha> --verdict approve|changes-requested --json <file|->`: the ticket's RECORDED REVIEWER records the verdict
// and each finding of the exact head it read; counts are derived. `gate` / `deliver` read nothing else. Rule = `recordReview` (src/shared/fanout-record.ts); the caller = `resolveCaller` (#588).
import fs from 'node:fs';
import path from 'node:path';
import { FanoutStateError, SeatRefusal, readState, resolveFanoutRun, seatRecordsOn, stateFile, updateState } from '../shared/fanout-state.ts';
import { isVouched, resolveCaller } from '../shared/fanout-caller.ts';
import { countsThrough, parseRecordJson, recordReview, reviewerDoneRefusal } from '../shared/fanout-record.ts';
import { citationsOf, isProductPath } from '../shared/fanout-demonstration.ts';
import { fileOnHead, homeOf, parseArgs, runOf, treeOfSha, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const RECORD_USAGE = `usage: orchestra fanout record <ticket> --head <sha> --verdict approve|changes-requested --json <file|-> [--run <id>]
         (#589, switch seatRecords=on) the ticket's RECORDED REVIEWER records its verdict and its findings for the exact head it read — the only source of a review verdict: \`fanout gate\` and
         \`fanout deliver\` read nothing else (\`deliver --review-verdict\`, \`--no-review-gate\`, the coordinator's \`state set --finding\` / \`--finding-json\` / \`--settle\` are refused: [typed-verdict], [ungated-merge], [finding-source]).
         The --json: {"findings":{"<id>":{"severity":"BLOCKING|MAJOR|MINOR","evidence":"measured|argued","text":"<the finding>","demonstration"?:{…},"report"?:{…},"specSentence"?:"<verbatim spec text>","kind"?:"code|process"}},
                      "fixed":["<id of an open finding you raised on an earlier head and have now read fixed on THIS head>",…]}   (the severity / report / specSentence / demonstration rules are those of \`state set --finding-json\`)
         Counts (BLOCKING / MAJOR / MINOR) are DERIVED from the open findings, never typed. approve is refused while a BLOCKING / MAJOR (or a blocking MINOR under this run's minorPolicy) finding is open; changes-requested needs one.
         Refusals (each starts with its name): [record-off] [record-wrong-ticket] (no recorded reviewer on the ticket) [record-not-reviewer] (you are not the ticket's recorded reviewer: coordinator, implementer, another ticket's reviewer)
         [record-head-mismatch] (--head is not the head you were briefed on) [record-verdict] [record-json] [finding-exists] [fixed-not-open] [fixed-same-head] [fixed-by-non-reviewer] [approve-open-finding] [changes-no-finding].
         Your worker_done is refused ([record-missing]) until the verdict of your head is recorded. The coordinator's way of NOT fixing a finding: \`state set <ticket> --decide <finding>=<reason>\` (a reason is required, listed by \`fanout closeout\`).
         A reviewer has no run of its own: --run defaults to your coordinator's run (as for \`state show\`). Exit 0 recorded · 2 refused · 1 usage / unreadable.`;

export function runRecord(args: string[], deps: FanoutDeps): RunResult {
  try { return record(args, deps); } catch (e) {
    if (e instanceof SeatRefusal) return { code: 2, stdout: '', stderr: `${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function record(args: string[], deps: FanoutDeps): RunResult {
  if (args[0] === '--help' || args[0] === '-h') return { code: 0, stdout: `${RECORD_USAGE}\n`, stderr: '' };
  const p = parseArgs(args, ['--run', '--head', '--verdict', '--json'], []);
  const [ticket, ...extra] = p.pos;
  if (!ticket || extra.length || p.vals['--head'] === undefined || p.vals['--verdict'] === undefined || p.vals['--json'] === undefined) throw new FanoutStateError(RECORD_USAGE);
  const r = runOf(p, deps, 'use');
  const file = stateFile(homeOf(deps.env), r.run);
  const cur = readState(file);
  if (!cur) throw new FanoutStateError(`no state at ${file} — pass --run <the coordinator's run id>`);
  if (!seatRecordsOn(cur)) return recordReviewOffRefusal(cur.run, r.note);
  let text: string;
  if (p.vals['--json'] === '-') text = deps.readStdin();
  else {
    try { text = fs.readFileSync(path.resolve(deps.cwd, p.vals['--json']), 'utf8'); } catch (e) { throw new FanoutStateError(`cannot read the --json file ${p.vals['--json']}: ${(e as Error).message}`); }
  }
  const input = parseRecordJson(text);
  const head = p.vals['--head'];
  const repo = cur.repo ?? null;
  // git / gh reads happen HERE, before the state lock (a slow gh inside it lets a second writer break the lock)
  const tree = /^[0-9a-f]{7,40}$/.test(head) ? treeOfSha(deps.runner, head, deps.cwd, repo) : null;
  const known = new Map<string, boolean | null>();
  for (const f of Object.values(input.findings)) {
    const obs = (f.demonstration as { observed?: unknown } | undefined)?.observed;
    if (/^[0-9a-f]{7,40}$/.test(head) && typeof obs === 'string') for (const c of citationsOf(obs)) if (isProductPath(c.path) && !known.has(c.path)) known.set(c.path, fileOnHead(deps.runner, head, c.path, deps.cwd, repo));
  }
  const caller = resolveCaller(cur, deps.env, deps.identity); // #588: the host's answer for THIS call, never the env alone
  const next = updateState(file, (s) => {
    if (!s) throw new FanoutStateError(`no state at ${file}`);
    return recordReview(s, ticket, { head, verdict: p.vals['--verdict'], input, callerId: caller.id, callerVouched: isVouched(caller), tree, now: deps.now(), fileOnHead: (h, f) => (known.has(f) ? known.get(f)! : null) });
  });
  const t = next.tickets[ticket];
  const rv = t.reviews![t.reviews!.length - 1];
  const c = countsThrough(t, rv.n);
  const note = tree ? '' : `note: the tree of ${head.slice(0, 8)} is unreadable (not fetched? gh?): this verdict stays keyed on the sha, not the content\n`;
  return { code: 0, stdout: `${ticket}: review ${rv.n} recorded by ${rv.reviewer} on ${rv.head.slice(0, 12)}: ${rv.verdict} — ${c.blocking} BLOCKING / ${c.major} MAJOR / ${c.minor} MINOR open${c.open.length ? ` (${c.open.join(', ')})` : ''}; raised ${rv.findings.length}, closed ${rv.closed.length}\n`, stderr: r.note + note };
}

function recordReviewOffRefusal(run: string, note: string): RunResult {
  return { code: 2, stdout: '', stderr: `${note}[record-off] seatRecords is off for run ${run} — nothing is recorded; the verdict file (deliver --review-verdict) stays the way\n` };
}

/** #589 (seatRecords=on) — the fanout state of the run a completion is filed in names its sender as a recorded reviewer with no verdict on its head: the refusal text (it prints the command). Reads the state file; unreadable / absent / switch off = null (never blocks a worker_done it cannot judge). */
export function fanoutCompletionRefusal(sender: string, runId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const state = readState(stateFile(homeOf(env), runId));
    return state ? reviewerDoneRefusal(state, sender) : null;
  } catch { return null; }
}

/** `state set … --decide|--json` on a run whose seatRecords is ON: index.ts then asks the host who the caller is (a decision is the coordinator's, vouched). Reads the state only; false for anything it cannot read. */
export function stateSetNeedsHost(args: string[], env: NodeJS.ProcessEnv): boolean {
  if (args[0] !== 'state' || args[1] !== 'set' || !(args.includes('--decide') || args.includes('--json'))) return false;
  const i = args.indexOf('--run');
  try {
    const { run } = resolveFanoutRun(i >= 0 ? args[i + 1] : undefined, env);
    return !!run && seatRecordsOn(readState(stateFile(homeOf(env), run)));
  } catch { return false; }
}
