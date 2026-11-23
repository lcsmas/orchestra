// #553 — `orchestra fanout closeout [--run <id>] [--json] [--file [--repo owner/name]]`: one ready-to-file ticket text per MEASURED, non-process MINOR of the vague.
// READ-ONLY on the state. The default output is the list (for the ledger closing report) and NO tracker call; `--file` is the opt-in filing, best effort,
// never changes the exit code and never gates anything (the run does not wait for it). The rule is `closeoutTexts` (src/shared/fanout-closeout.ts).
import { FanoutStateError, stateFile } from '../shared/fanout-state.ts';
import { closeoutTexts, renderCloseout, type TicketText } from '../shared/fanout-closeout.ts';
import { homeOf, loadOrFail, parseArgs, runOf, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const CLOSEOUT_USAGE = `       orchestra fanout closeout [--run <id>] [--json] [--file [--repo <owner/name>]]
                                  (#553, read-only: ONE ready-to-file ticket text — input / what happens / where / proof — per MEASURED MINOR on product code recorded on
                                  the vague's tickets; an argued MINOR, a \`kind: process\` finding and one settled \`fixed\` create nothing — after a follow-up fixed a MINOR, settle it (\`state set <ticket> --settle <id>=fixed:<ref>\`), else its text stays. Paste the list into the ledger
                                  closing report. Filing in a tracker is --file, OFF by default: best effort via gh (dedupe by a hidden marker), never changes the exit code,
                                  never waited on. Exit 0 always when the state reads.)`;

export function runCloseout(args: string[], deps: FanoutDeps): RunResult {
  try { return closeout(args, deps); } catch (e) {
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function closeout(args: string[], deps: FanoutDeps): RunResult {
  const p = parseArgs(args, ['--run', '--repo'], ['--json', '--file']);
  if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]}`);
  if (p.vals['--repo'] !== undefined && !p.bools.has('--file')) throw new FanoutStateError('--repo only applies to --file');
  const r = runOf(p, deps, 'use');
  const state = loadOrFail(stateFile(homeOf(deps.env), r.run));
  const res = closeoutTexts(state);
  const out = p.bools.has('--json') ? `${JSON.stringify({ run: state.run, texts: res.texts, skipped: res.skipped, noEvidence: res.noEvidence, settledFixed: res.settledFixed, malformed: res.malformed }, null, 2)}\n` : renderCloseout(res, state.run);
  if (!p.bools.has('--file')) return { code: 0, stdout: out, stderr: r.note };
  const repo = p.vals['--repo'] ?? state.repo ?? null;
  const lines = res.texts.map((t) => fileOne(t, repo, deps));
  return { code: 0, stdout: out, stderr: `${r.note}${lines.length ? `filing (best effort, exit code unaffected): \n${lines.join('\n')}\n` : 'filing: nothing to file\n'}` };
}

/** One text → the tracker. Never throws: a failure is a line, the list above already holds the text. */
function fileOne(t: TicketText, repo: string | null, deps: FanoutDeps): string {
  const R = repo ? ['-R', repo] : [];
  try {
    const found = deps.runner('gh', ['issue', 'list', ...R, '--state', 'all', '--search', `${t.marker} in:body`, '--json', 'number,url', '--limit', '1'], deps.cwd);
    if (found.code === 0) {
      const hit = (JSON.parse(found.stdout || '[]') as Array<{ number: number; url?: string }>)[0];
      if (hit) return `  ${t.ticket}/${t.finding}: already filed (#${hit.number}${hit.url ? ` ${hit.url}` : ''}) — skipped`;
    } else return `  ${t.ticket}/${t.finding}: NOT filed — could not check for an existing issue (gh exit ${found.code}: ${found.stderr.trim().slice(0, 160)})`;
    const made = deps.runner('gh', ['issue', 'create', ...R, '--title', t.title, '--body', t.body], deps.cwd);
    return made.code === 0 ? `  ${t.ticket}/${t.finding}: filed ${made.stdout.trim().split('\n').pop()}` : `  ${t.ticket}/${t.finding}: NOT filed — gh exit ${made.code}: ${made.stderr.trim().slice(0, 160)}`;
  } catch (e) {
    return `  ${t.ticket}/${t.finding}: NOT filed — ${e instanceof Error ? e.message : String(e)}`;
  }
}
