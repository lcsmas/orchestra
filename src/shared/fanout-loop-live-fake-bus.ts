// #614 — a fake `orchestra` CLI + host over the DUMMY world, for the live fleet's contract and composed tests: it answers in the shapes of the real verbs (a bus whose plain `check` never acks and replays an outstanding lot,
// `question` for an ask, the `[name]` refusal text). `fanout start` / `fanout review` delegate to the dummy's own ports (the real `startRun` / reviewer host path). The mail protocol is also run on the REAL bus (src/cli/fanout-loop-live-bus.test.ts).
import { readState, stateFile } from './fanout-state.ts';
import type { Dummy } from './fanout-loop-dummy.ts';
import type { Cli, Host } from './fanout-loop-live-fleet.ts';
import type { ExecResult } from './fanout-loop-live-git.ts';

/** A fake `orchestra` CLI + host on the dummy world: it answers in the shapes of the real verbs (a bus whose plain `check` never acks, `question` for an ask, the `[name]` refusal text). */
export function fakeBus(d: Dummy, run: string, home: string): { cli: Cli; host: Host; lots: number[]; calls: string[][]; fail: { start?: ExecResult } } {
  const mailbox = (d.world as unknown as { mailbox: Array<{ seq: number; kind: string; sender: string; body: string }> }).mailbox;
  const state = { cursor: 0, lot: 0, held: null as null | { id: number; from: number; to: number } };
  const calls: string[][] = [];
  const lots: number[] = [];
  const fail: { start?: ExecResult } = {};
  const out = (stdout: string, code = 0, stderr = ''): Promise<ExecResult> => Promise.resolve({ code, stdout, stderr });
  const cli: Cli = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'fanout' && b === 'start') { if (fail.start) return fail.start; const r = await d.fleet.start(); return out(`${JSON.stringify(r)}\n`, r.failed.length ? 2 : 0); }
    if (a === 'fanout' && b === 'review') { const t = readState(stateFile(home, run))!.tickets[args[2]]; await d.fleet.spawnReviewer(args[2], t.head!); return out(`${args[2]}: asking Orchestra for its reviewer\n`); }
    if (a === 'run' && b === 'status') return out(`${JSON.stringify({ runId: run, runExists: true, pause: d.world.paused ? { runId: run, pausedAt: d.world.pauseSince, pausedBy: d.world.pauseBy, mode: 'hard', trapAt: null, resumeStartedAt: null } : null, inherited: false, bilan: [], lastPause: null, reprise: null, stillPausedBy: null })}\n`); // #idle: `orchestra run status --json`
    if (a === 'check') {
      const limit = Number(args[args.indexOf('--limit') + 1]) || 100;
      if (!state.held) {
        const next = mailbox.filter((m) => m.seq > state.cursor).slice(0, limit);
        if (next.length) state.held = { id: ++state.lot, from: next[0].seq - 1, to: next[next.length - 1].seq };
      }
      const msgs = state.held ? mailbox.filter((m) => m.seq > state.held!.from && m.seq <= state.held!.to) : [];
      if (state.held) lots.push(state.held.id);
      return out(`${JSON.stringify({ run, reader: run, lot: state.held?.id ?? null, replay: false, from: state.held?.from ?? 0, to: state.held?.to ?? 0, count: msgs.length, messages: msgs.map((m) => ({ sequence: m.seq, kind: m.kind === 'ask' ? 'question' : m.kind, sender: m.sender, recipient: run, thread_id: null, body: m.body, created_at: 0 })), gates: [] })}\n`);
    }
    if (a === 'ack') {
      if (!state.held || String(state.held.id) !== b) return out('', 1, `orchestra ack: lot ${b} is not an outstanding lot for ${run} in run ${run} (already acked, unknown id, or another reader's lot)\n`);
      state.cursor = state.held.to; state.held = null; return out(`acked ${b}\n`);
    }
    if (a === 'send') {
      const to = args[args.indexOf('--to') + 1];
      const text = args.slice(args.indexOf('--') + 1).join(' ');
      if (!d.world.impls.has(to) && !d.world.revs.has(to)) return out('', 1, `orchestra send: ${to} is not a live workspace\n`);
      if (/^CONNECT /.test(text)) d.world.wakeImpl(to, text); else d.world.answerImpl(to, text);
      return out('');
    }
    return out('', 1, `fake cli: unsupported: ${args.join(' ')}`);
  };
  const host: Host = async (body) => {
    if (body.op === 'live') { const live = (body.ids as string[]).filter((id) => d.world.impls.has(id) || d.world.revs.has(id)); return { ok: true, op: 'live', live, idle: Object.fromEntries(live.flatMap((id) => { const ms = d.world.idleFor(id); return ms === null ? [] : [[id, ms]]; })) }; } // idle-rule: the host's idle clock
    if (body.op === 'release') { const released = (body.ids as string[]).filter((id) => d.world.impls.has(id) || d.world.revs.has(id)); for (const id of released) { const a = d.world.impls.get(id); if (a) { d.world.impls.delete(id); d.world.ev('impl-replaced', a.ticket, { ws: id }); } else d.world.releaseReviewer(d.world.revs.get(id)!.ticket); } return { ok: true, op: 'release', released }; } // #628: the host archives an implementer (idle-rule: or a reviewer)
    return { ok: false, error: 'unsupported' };
  };
  return { cli, host, lots, calls, fail };
}
