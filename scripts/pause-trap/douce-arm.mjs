// Pause DOUCE arms of the pause-trap rig (#254, wave E ledger #276 G3). Loaded by driver.mjs (inside the same net+pid namespace):
// real keeper → real `claude` CLI → real Bash-tool processes against the scripted fake API; the pause is written by the REAL built
// `orchestra run pause` (no --hard); the host is the REAL pause-trap + pause-douce code wired like index.ts; the order reaches the member through the REAL
// posttool hook script (installed by the REAL installOrchestraHooks) as the tool result's additionalContext. Every arm reports time-to-all-paused,
// time-to-all-confirmed and lost-work (work markers found in NEITHER the member's HEAD, its pushed branch nor the pause ref).
import fs from 'node:fs';
import path from 'node:path';

const BASH = (command, extra = {}) => ({ tool: { name: 'Bash', input: { command, description: 'pause-douce rig', timeout: 600000, ...extra } } });
const commandsOf = (assistant) => assistant.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'tool_use').map((b) => String(b.input?.command ?? '')) : []));

/** Function scenarios for the fake API (see fake-api.mjs `locateStep`). `cli` = the built CLI the member runs to confirm. */
export function douceScenarios(cli) {
  const loop = (ctx) => BASH(`echo step-${ctx.idx} >> progress.txt; sleep 1`);
  return {
    // obeys: keeps working (quick tool calls) until the order shows in a tool result, then commits + pushes its work, confirms, ends its turn
    loopobey: (ctx) => {
      const did = commandsOf(ctx.assistant);
      const committed = did.some((c) => /git .*commit/.test(c));
      // the hook's context is attached to ONE request (the one right after the tool result), so "ordered" is carried by what the model already did
      if (!committed) return ctx.order ? BASH("git add -A && git -c user.name=rig -c user.email=r@r commit -qm douce-save && git push -q origin HEAD:refs/heads/douce-save") : loop(ctx);
      if (!did.some((c) => /confirm pause/.test(c))) return BASH(`node ${cli} run confirm pause`);
      return { text: 'paused' };
    },
    // the same, but every work command FAILS (exit 3): the order must reach the member through PostToolUseFailure too
    loopobeyfail: (ctx) => {
      const did = commandsOf(ctx.assistant);
      const committed = did.some((c) => /git .*commit/.test(c));
      if (!committed) return ctx.order ? BASH("git add -A && git -c user.name=rig -c user.email=r@r commit -qm douce-save && git push -q origin HEAD:refs/heads/douce-save") : BASH(`echo step-${ctx.idx} >> progress.txt; sleep 1; exit 3`);
      if (!did.some((c) => /confirm pause/.test(c))) return BASH(`node ${cli} run confirm pause`);
      return { text: 'paused' };
    },
    // runs a SUBAGENT (its own tool calls fire hooks with the member's identity), then obeys once the order reaches ITS OWN next boundary
    parentsub: (ctx) => {
      const did = commandsOf(ctx.assistant);
      const usedAgent = ctx.assistant.some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_use' && b.name === 'Agent'));
      if (!usedAgent) return { tool: { name: 'Agent', input: { description: 'rig subagent', prompt: 'SCN:subwork do the rig work', subagent_type: 'general-purpose' } } };
      const committed = did.some((c) => /git .*commit/.test(c));
      // the Agent tool returns at once (the subagent runs in the background): a long command keeps the PARENT away from any boundary while the subagent's own calls fire hooks
      if (!did.some((c) => /sleep 8/.test(c))) return BASH('sleep 8');
      if (!committed) return ctx.order ? BASH("git add -A && git -c user.name=rig -c user.email=r@r commit -qm douce-save && git push -q origin HEAD:refs/heads/douce-save") : BASH('sleep 1');
      if (!did.some((c) => /confirm pause/.test(c))) return BASH(`node ${cli} run confirm pause`);
      return { text: 'paused' };
    },
    // the subagent's own work: slow tool calls, in the member's worktree
    subwork: (ctx) => (ctx.idx < 12 ? BASH(`echo sub-${ctx.idx} >> subprogress.txt; sleep 1`) : { text: 'sub done' }),
    // never answers: reads the order and keeps going
    loopsilent: loop,
    // out of quota: works until the plan is exhausted (the driver flips flags.quota at the pause), then every request is refused
    loopquota: (ctx) => (ctx.flags.quota ? { http: { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'plan exhausted (pause-douce rig)' } } } } : loop(ctx)),
    // blocked in ONE long command: it can never reach a tool-result boundary
    longcmd: (ctx) => (ctx.idx === 0 ? BASH('echo blocked-work > blocked-work.txt; sleep 7731') : { text: 'done' }),
    // a turn that already ended (the member is idle with uncommitted work)
    idleend: () => ({ text: 'ok' }),
  };
}

const OBEY = { id: 'mid', scenario: 'loopobey', kind: 'obey', files: {} };
const OBEYFAIL = { id: 'mdf', scenario: 'loopobeyfail', kind: 'obey', files: {} };
const OBEYSUB = { id: 'msb', scenario: 'parentsub', kind: 'obey', sub: true, files: {} };
const BLOCKED = { id: 'blk', scenario: 'longcmd', kind: 'blocked', files: {}, marker: 7731 };
const SILENT = { id: 'sil', scenario: 'loopsilent', kind: 'silent', files: {} };
const QUOTA = { id: 'qta', scenario: 'loopquota', kind: 'quota', files: {} };
const IDLE = { id: 'idl', scenario: 'idleend', kind: 'idle', files: { 'idle-work.txt': 'IDLE-WORK\n' } };

/** `deadlineSec`: null = the REAL 3 min; a number rewrites `pause_deadline_at` (a fixture: the mutant arms must not each wait 3 min). `early`: the escalation must come BEFORE the deadline. */
export const DOUCE_ARMS = {
  'douce-obey': { members: [OBEY, IDLE], early: true, deadlineSec: 60 },
  'douce-failcall': { members: [OBEYFAIL], early: true, deadlineSec: 60 },
  'douce-subagent': { members: [OBEYSUB], early: true, deadlineSec: 60 },
  'douce-quota': { members: [QUOTA], early: true, deadlineSec: 60, quota: true },
  'douce-blocked': { members: [BLOCKED], early: false, deadlineSec: null },
  'douce-silent': { members: [SILENT], early: false, deadlineSec: null },
  'douce-mixed': { members: [OBEY, SILENT, IDLE], early: false, deadlineSec: 40 },
  'douce-fleet': { members: [OBEY, BLOCKED, QUOTA, SILENT, IDLE], early: false, deadlineSec: null, quota: true },
  // the app DIES mid-douce (after the order was delivered): nothing escalates while it is down, the keeper + CLI keep working; the restarted app's boot drain escalates (deadline long past) and traps
  'douce-restart': { members: [SILENT], early: false, deadlineSec: 25, restart: true },
  'douce-off': { members: [OBEY], off: true },
};

export async function runDouce(ctx) {
  const { A, arm, api, cfg, startApp, cli, waitFor, sleep, check, result, allProcs, live, alive, gitOut, readProc, home, orchHome, REPO, SRC, root, importSrc } = ctx;
  const members = A.members;
  const deadlineSec = cfg.deadlineSec ?? A.deadlineSec; // a mutant arm shortens the real 3 min (a fixture), the real arms leave it null
  const WT = (id) => path.join(root, `wt-${id}`);
  const read = (id, f) => { try { return fs.readFileSync(path.join(WT(id), f), 'utf8'); } catch { return null; } };
  const sleepersOf = (n) => allProcs().filter((p) => live(p) && p.comm === 'sleep' && p.argv[1] === String(n));
  const keeperOf = (id) => allProcs().find((p) => live(p) && p.argv.some((a) => a.endsWith('keeper.js')) && p.argv.includes(id));
  const cliOfKeeper = (k) => allProcs().find((p) => live(p) && p.ppid === k.pid && /claude/.test(p.argv[0] ?? ''));
  const busMod = await importSrc('src/main/bus.ts');
  const douce = await importSrc('src/main/pause-douce.ts').catch(() => null); // absent on MASTER (the unfixed arm stops at the refused soft pause)
  const busFile = path.join(orchHome, 'bus.sqlite');
  const ro = () => busMod.open(busFile, { readonly: true });
  const withRo = (fn) => { const db = ro(); try { return fn(db); } finally { db.close(); } };
  const carrierRow = () => withRo((db) => db.prepare('SELECT paused_at, pause_mode, pause_deadline_at, pause_escalated_at, pause_trap_at FROM runs WHERE id = ?').get('ops'));
  const rosterNow = (pausedAt) => withRo((db) => douce.listRoster(db, 'ops', pausedAt));
  const sleepFor = sleep;

  // 1. fleet up: every member starts its own turn
  const app = startApp('first', { workers: members.map((m) => ({ id: m.id, scenario: m.scenario, files: m.files })), pauseSwitch: !A.off, statusSock: true });
  const sockEnv = { ORCHESTRA_SOCK: path.join(root, 'orch.sock') };
  await app.waitEv((e) => e.ev === 'all-sent', 180_000, 'every member to be sent its turn');

  // 2. POSITIVE CONTROLS: each member really works before the pause
  for (const m of members) {
    if (m.kind === 'idle') {
      await app.waitEv((e) => e.ev === 'turn-end' && e.ws === m.id, 90_000, `${m.id}'s turn to end`);
    } else if (m.kind === 'blocked') {
      await waitFor(() => sleepersOf(m.marker).length >= 1, 90_000, `${m.id}'s long command`);
    } else if (m.sub) {
      await waitFor(() => (read(m.id, 'subprogress.txt') ?? '').split('\n').filter(Boolean).length >= 2, 120_000, `${m.id}'s subagent to make progress`);
    } else {
      await waitFor(() => (read(m.id, 'progress.txt') ?? '').split('\n').filter(Boolean).length >= 3, 90_000, `${m.id} to make progress`);
    }
  }
  const keepers = Object.fromEntries(members.map((m) => [m.id, keeperOf(m.id)]));
  const clis = Object.fromEntries(members.map((m) => [m.id, keepers[m.id] && cliOfKeeper(keepers[m.id])]));
  check('members_have_live_keeper_and_cli', members.every((m) => keepers[m.id] && clis[m.id]), members.map((m) => `${m.id}: keeper ${keepers[m.id]?.pid ?? '-'} cli ${clis[m.id]?.pid ?? '-'}`).join(' · '));
  const liveMembers = members.filter((m) => m.kind !== 'idle');
  const workFile = (m) => (m.sub ? 'subprogress.txt' : 'progress.txt');
  const linesNow = (m) => (read(m.id, workFile(m)) ?? '').split('\n').filter(Boolean);
  if (A.quota) api.flags.quota = true; // from now on the quota member's NEXT request is refused (its in-flight command still finishes)
  const pre = Object.fromEntries(members.map((m) => [m.id, { lines: linesNow(m), blocked: read(m.id, 'blocked-work.txt'), idle: read(m.id, 'idle-work.txt') }]));

  // 3. THE PAUSE (Pause douce) through the REAL built CLI
  const tPause = Date.now();
  result.tPause = tPause;
  const p = cli('run', 'pause', '--run', 'ops', '--as', 'lead');
  if (A.off) return offArm(p);
  check('cli_pause_soft_accepted', p.rc === 0 && /PAUSE DOUCE/.test(p.out), `rc=${p.rc} ${p.out.trim().slice(0, 160)}`);
  if (p.rc !== 0) return; // nothing was paused (master refuses a pause without --hard): there is nothing further to measure
  const row0 = await waitFor(() => { const r = carrierRow(); return r?.paused_at ? r : null; }, 15_000, 'paused_at').catch(() => null);
  check('soft_row_written', !!row0 && row0.pause_mode === 'soft' && row0.pause_deadline_at === row0.paused_at + 180_000 && row0.pause_escalated_at === null, JSON.stringify(row0));
  if (!row0) return;
  const pausedAt = row0.paused_at;
  if (deadlineSec !== null && deadlineSec !== undefined) {
    // FIXTURE: shorten the deadline so a mutant arm does not wait 3 min (the real-3-min arms leave it alone).
    const db = busMod.open(busFile);
    try { db.prepare('UPDATE runs SET pause_deadline_at = ? WHERE id = ?').run(pausedAt + deadlineSec * 1000, 'ops'); } finally { db.close(); }
  }
  const deadlineAt = deadlineSec ? pausedAt + deadlineSec * 1000 : pausedAt + 180_000;

  // 4. the gates refuse every AUTO start AT ONCE
  const target = members[0].id;
  app.send({ cmd: 'auto-send', ws: target, text: 'SCN:idleend' });
  const gate = await waitFor(() => app.replies.find((r) => r.cmd === 'auto-send' || r.reply === 'auto-send' || (r.reply === 'error' && r.cmd === 'auto-send')), 15_000, 'the auto-send answer').catch(() => null);
  check('gate_refuses_auto_start_at_once', !!gate && gate.reply === 'error' && /run en pause/.test(gate.error ?? ''), gate ? `${gate.reply}: ${String(gate.error ?? '').split('\n')[0].slice(0, 120)}` : 'no answer');

  // 4b. the app dies mid-douce (restart arm): the order was delivered, then nothing can act until the app is back
  let tBoot = null;
  if (A.restart) {
    const first = members[0];
    await waitFor(() => api.requests.some((r) => r.scn === first.scenario && r.order && r.t >= pausedAt), 20_000, 'the order to reach the member before the app dies');
    const alive0 = { keeper: keepers[first.id].pid, cli: clis[first.id].pid };
    app.child.kill('SIGKILL');
    await waitFor(() => app.exited, 10_000, 'the app to die');
    const l0 = linesNow(first).length;
    await sleepFor(Math.max(0, deadlineAt - Date.now()) + 5000); // past the deadline, app DOWN
    const row = carrierRow();
    check('app_down_nothing_escalates_or_traps', row.pause_escalated_at === null && row.pause_trap_at === null && alive(alive0.keeper, keepers[first.id].start) && linesNow(first).length > l0, `escalated=${row.pause_escalated_at} trap=${row.pause_trap_at}; the member kept working while the app was down (${l0} → ${linesNow(first).length} lines)`);
    const app2 = startApp('second', { workers: members.map((m) => ({ id: m.id, scenario: m.scenario, files: m.files })), statusSock: true });
    await app2.waitEv((e) => e.ev === 'trap-started', 120_000, 'app2 boot');
    tBoot = Date.now();
  }

  // 5. watch the roster until the trap is done (or the budget runs out)
  const confirmedAt = {}; // ws → { t, via }
  let escalatedAt = null, trapAt = null, busLine = null, busLineExpect = null;
  const budgetMs = (deadlineSec ?? 180) * 1000 + 90_000;
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const rr = carrierRow();
    const roster = rosterNow(pausedAt);
    for (const r of roster) if (r.pauseConfirmedAt !== null && !confirmedAt[r.wsId]) confirmedAt[r.wsId] = { t: r.pauseConfirmedAt, via: r.pauseConfirmVia };
    if (rr?.pause_escalated_at && escalatedAt === null) escalatedAt = rr.pause_escalated_at;
    // bus-status mid-douce: the REAL CLI against the stand-in socket, compared with the DB read around it
    if (busLine === null && !rr?.pause_escalated_at && roster.length >= members.length + 1 && roster.some((r) => r.pauseConfirmedAt !== null) && roster.some((r) => r.pauseConfirmedAt === null)) {
      const before = roster.filter((r) => r.pauseConfirmedAt !== null).length;
      const o = cli2(['bus-status', '--run', 'ops']);
      const after = rosterNow(pausedAt).filter((r) => r.pauseConfirmedAt !== null).length;
      busLine = o.out.split('\n').find((l) => l.startsWith('pause:')) ?? `(no pause: line) ${o.out.slice(0, 200)}`;
      busLineExpect = { before, after, total: roster.length, missing: roster.filter((r) => r.pauseConfirmedAt === null).map((r) => r.wsId) };
    }
    if (rr?.pause_trap_at) { trapAt = rr.pause_trap_at; break; }
    await sleepFor(200);
  }
  function cli2(args) {
    return ctx.cliWith(args, sockEnv);
  }
  const rowEnd = carrierRow();
  const roster = rosterNow(pausedAt);
  for (const r of roster) if (r.pauseConfirmedAt !== null && !confirmedAt[r.wsId]) confirmedAt[r.wsId] = { t: r.pauseConfirmedAt, via: r.pauseConfirmVia };
  check('trap_finished', !!trapAt, trapAt ? `pause_trap_at ${trapAt - pausedAt} ms after the pause` : 'the trap never finished within the budget');
  const allPausedMs = trapAt ? trapAt - pausedAt : null;
  const allConfirmedMs = roster.length && roster.every((r) => r.pauseConfirmedAt !== null) ? Math.max(...roster.map((r) => r.pauseConfirmedAt)) - pausedAt : null;
  result.metrics = { arm, deadlineMs: deadlineAt - pausedAt, escalatedAfterMs: escalatedAt ? escalatedAt - pausedAt : null, timeToAllPausedMs: allPausedMs, timeToAllConfirmedMs: allConfirmedMs };

  // 6. ESCALATION: all-confirmed arms escalate early; arms with a straggler wait for the deadline (and not much longer)
  if (A.restart) check('restart_boot_drain_escalates_the_overdue_douce', !!escalatedAt && escalatedAt >= deadlineAt && tBoot !== null && escalatedAt - tBoot <= 10_000, `escalated ${escalatedAt ? escalatedAt - (tBoot ?? 0) : '-'} ms after the app came back (deadline passed ${tBoot ? tBoot - deadlineAt : '-'} ms before it did)`);
  else if (A.early) check('escalated_early_all_confirmed', !!escalatedAt && escalatedAt < deadlineAt - 5000, `escalated ${escalatedAt ? escalatedAt - pausedAt : '-'} ms after the pause, deadline at ${deadlineAt - pausedAt} ms`);
  else check('straggler_not_cut_short_then_escalated_at_deadline', !!escalatedAt && escalatedAt >= deadlineAt && escalatedAt - deadlineAt <= 4000, `escalated ${escalatedAt ? escalatedAt - pausedAt : '-'} ms after the pause; deadline ${deadlineAt - pausedAt} ms (want [deadline, deadline+4 s])`);
  check('no_trap_before_escalation', !!trapAt && !!escalatedAt && trapAt >= escalatedAt, `escalated at +${escalatedAt ? escalatedAt - pausedAt : '-'} ms, trap done at +${trapAt ? trapAt - pausedAt : '-'} ms (a Pause douce owes the host trap only once escalated)`);
  // the trap must not even START before the escalation: the earliest Bilan row (written before any process is touched) is never older than escalated_at
  const firstBilanAt = withRo((db) => db.prepare("SELECT MIN(created_at) AS c FROM pause_records WHERE run_id = ? AND paused_at = ? AND ws_id != '__pause_origin__'").get('ops', pausedAt)?.c ?? null);
  check('trap_not_started_before_escalation', firstBilanAt !== null && !!escalatedAt && firstBilanAt >= escalatedAt, `first Bilan row at +${firstBilanAt ? firstBilanAt - pausedAt : '-'} ms, escalated at +${escalatedAt ? escalatedAt - pausedAt : '-'} ms (the trap's first act is a member's Bilan row; the reserved __pause_origin__ row is the CLI's, written at pause time)`);
  check('time_to_all_paused_within_deadline_plus_trap', allPausedMs !== null && allPausedMs <= (deadlineAt - pausedAt) + 20_000, `all paused ${allPausedMs} ms after the pause (deadline ${deadlineAt - pausedAt} ms + ≤ 20 s for the trap)`);

  // 7. ORDER delivery at a tool-result boundary (+ latency) / never for the blocked member
  const latencyOf = (m) => { const rq = api.requests.find((r) => r.scn === m.scenario && r.order && r.t >= pausedAt); return rq ? rq.t - pausedAt : null; };
  result.metrics.orderLatencyMs = {};
  for (const m of members) {
    const lat = latencyOf(m);
    if (m.kind === 'obey' || m.kind === 'silent') {
      result.metrics.orderLatencyMs[m.id] = lat;
      check(`order_delivered_at_tool_boundary_${m.id}`, lat !== null && lat < (m.sub ? 20_000 : 8000) && (!m.sub || lat > 2000), lat === null ? `${m.id}'s model never saw the pause order` : `the order reached ${m.id}'s model ${lat} ms after the pause (next tool-result boundary; its tool calls are 1 s)`);
    } else if (m.kind === 'quota') {
      result.metrics.orderLatencyMs[m.id] = lat; // out of quota: it may die before the boundary — reported, not required
    } else if (m.kind === 'blocked') {
      check(`blocked_member_cannot_see_the_order_${m.id}`, lat === null, lat === null ? 'no tool-result boundary inside the long command ⇒ no delivery (the deadline is the only way)' : `unexpected: the blocked member saw the order after ${lat} ms`);
    }
  }
  const pauseRows = withRo((db) => db.prepare("SELECT recipient, sender FROM messages WHERE kind = 'pause' ORDER BY sequence").all());
  for (const m of members.filter((x) => x.sub)) {
    const subReqs = api.requests.filter((r) => r.scn === 'subwork');
    const subAfterPause = subReqs.filter((r) => r.t >= pausedAt);
    check(`subagent_calls_never_took_the_order_${m.id}`, subAfterPause.length >= 2 && subAfterPause.every((r) => !r.order), `${subAfterPause.length} subagent request(s) after the pause (each follows a subagent tool call that fired the hook), ${subAfterPause.filter((r) => r.order).length} carried the order (the subagent's hook calls have agent_id: the order waits for the member's own boundary)`);
  }
  const must = members.filter((m) => ['obey', 'silent', 'blocked'].includes(m.kind)).map((m) => m.id);
  const may = members.filter((m) => m.kind === 'quota').map((m) => m.id);
  const got1 = pauseRows.map((r) => r.recipient);
  check('pause_rows_to_running_members_only', must.every((id) => got1.includes(id)) && got1.every((id) => must.includes(id) || may.includes(id)) && new Set(got1).size === got1.length && pauseRows.every((r) => r.sender === 'host'), `ONE row per running member from the host: [${got1.join(',')}]; required [${must.join(',')}], allowed [${may.join(',')}]; idle members get none`);

  // 8. ACCUSÉS: who confirmed how
  const want = { obey: 'member', idle: 'host-idle', quota: 'host-idle', blocked: 'trap', silent: 'trap' };
  const got = Object.fromEntries(roster.map((r) => [r.wsId, r.pauseConfirmVia]));
  check('roster_accusés_by_kind', members.every((m) => got[m.id] === want[m.kind]) && got.ops === 'host-idle', `want ${members.map((m) => `${m.id}:${want[m.kind]}`).join(' ')} ops:host-idle; got ${JSON.stringify(got)}`);
  check('every_member_confirmed', roster.length === members.length + 1 && roster.every((r) => r.pauseConfirmedAt !== null), `${roster.filter((r) => r.pauseConfirmedAt !== null).length}/${roster.length} confirmed`);
  if (!busLineExpect && !A.early && !A.restart) check('bus_status_window_captured', false, 'the mid-douce window (some members confirmed, some not) was never observed: bus-status was not checked — the arm proves nothing about it');
  if (busLineExpect) {
    const m = /pause: Pause douce en cours — (\d+)\/(\d+) en pause — manquent : (.+?) — Pause dure à /.exec(busLine ?? '');
    const k = m ? Number(m[1]) : -1;
    const missingNames = m ? m[3] : '';
    check('bus_status_names_who_is_missing', !!m && (k === busLineExpect.before || k === busLineExpect.after) && Number(m[2]) === busLineExpect.total && busLineExpect.missing.some((id) => missingNames.includes(id.slice(0, 8)) || missingNames.includes(id)), `bus-status: ${busLine} | db before=${busLineExpect.before} after=${busLineExpect.after} of ${busLineExpect.total}, missing ${busLineExpect.missing.join(',')}`);
  }

  // 9. THE WORK: nothing lost — the member's markers are in its HEAD, its pushed branch or the pause ref
  const rep = withRo((db) => db.prepare('SELECT ws_id, snapshot_ref, dirty, error FROM pause_records WHERE run_id = ? AND paused_at = ?').all('ops', pausedAt));
  const refOf = (id) => rep.find((r) => r.ws_id === id)?.snapshot_ref ?? null;
  const showAt = (id, rev, f) => { try { return gitOut(WT(id), 'show', `${rev}:${f}`); } catch { return null; } };
  const bareShow = (id, f) => { try { return gitOut(path.join(root, `origin-${id}.git`), 'show', `refs/heads/douce-save:${f}`); } catch { return null; } };
  let lost = 0;
  const lostDetail = [];
  for (const m of members) {
    const ref = refOf(m.id);
    const found = (f) => [showAt(m.id, 'HEAD', f), bareShow(m.id, f), ref ? showAt(m.id, ref, f) : null].filter((x) => x !== null).join('\n');
    if (m.kind === 'blocked') {
      const ok = /blocked-work/.test(found('blocked-work.txt')) && pre[m.id].blocked !== null;
      if (!ok) { lost++; lostDetail.push(`${m.id}: blocked-work.txt`); }
    } else if (m.kind === 'idle') {
      const ok = /IDLE-WORK/.test(found('idle-work.txt'));
      if (!ok) { lost++; lostDetail.push(`${m.id}: idle-work.txt`); }
    } else {
      const have = new Set(found(workFile(m)).split('\n').filter(Boolean));
      const missing = pre[m.id].lines.filter((l) => !have.has(l));
      lost += missing.length;
      if (missing.length) lostDetail.push(`${m.id}: ${missing.join(',')}`);
    }
  }
  result.metrics.lostWork = lost;
  check('lost_work_is_zero', lost === 0, lost === 0 ? `every work marker of ${members.length} member(s) is in HEAD / the pushed branch / the pause ref` : `LOST: ${lostDetail.join(' | ')}`);
  const refMembers = members.filter((m) => m.kind !== 'obey');
  check('pause_ref_written_for_dirty_members', refMembers.every((m) => !!refOf(m.id) && /^refs\/orchestra\/pause\/ops\//.test(refOf(m.id))), refMembers.map((m) => `${m.id}:${refOf(m.id) ?? 'none'}`).join(' '));
  const obey = members.find((m) => m.kind === 'obey');
  if (obey) check('obey_member_pushed_its_own_work', /step-|sub-/.test(bareShow(obey.id, workFile(obey)) ?? ''), `origin douce-save holds ${(bareShow(obey.id, workFile(obey)) ?? '').split('\n').filter(Boolean).length} line(s) of ${workFile(obey)}`);

  // 10. the host trap took the stragglers: their command is gone; sessions survive; nothing restarts
  const blk = members.find((m) => m.kind === 'blocked');
  if (blk) check('blocked_command_killed_by_the_trap', sleepersOf(blk.marker).length === 0, `sleep ${blk.marker} alive=${sleepersOf(blk.marker).length >= 1}`);
  check('cli_and_keeper_alive_after_trap', members.filter((m) => keepers[m.id] && clis[m.id]).every((m) => alive(keepers[m.id].pid, keepers[m.id].start) && alive(clis[m.id].pid, clis[m.id].start)), 'every member keeps its original keeper + CLI (the trap never kills them)');
  const grow = members.filter((m) => m.kind === 'silent' || m.kind === 'quota');
  if (grow.length) {
    const a = grow.map((m) => linesNow(m).length);
    await sleepFor(4000);
    const b = grow.map((m) => linesNow(m).length);
    check('stragglers_stopped_working', JSON.stringify(a) === JSON.stringify(b), `progress lines ${a.join(',')} → ${b.join(',')} over 4 s after the trap`);
  }
  // 11. lift: one verb clears every pause column
  const lift = cli('run', 'resume', '--run', 'ops', '--as', 'lead');
  const cleared = carrierRow();
  check('resume_clears_every_pause_column', lift.rc === 0 && cleared.paused_at === null && cleared.pause_mode === null && cleared.pause_deadline_at === null && cleared.pause_escalated_at === null && cleared.pause_trap_at === null, `rc=${lift.rc} ${JSON.stringify(cleared)}`);
  check('rig_ran_to_completion', true, '');
  result.members = members.map((m) => ({ id: m.id, kind: m.kind, via: got[m.id] ?? null, confirmedAfterMs: confirmedAt[m.id] ? confirmedAt[m.id].t - pausedAt : null }));
  return;

  // ── switch OFF: identical to today ────────────────────────────────────────
  async function offArm(pr) {
    check('off_cli_pause_refused', pr.rc !== 0 && /'pause' switch is OFF/.test(pr.out), `rc=${pr.rc} ${pr.out.trim().slice(0, 160)}`);
    check('off_nothing_written', (() => { const r = carrierRow(); return r.paused_at === null && r.pause_mode === null && r.pause_deadline_at === null && r.pause_escalated_at === null && r.pause_trap_at === null; })(), JSON.stringify(carrierRow()));
    // a STALE soft pause row on an OFF run (what a re-frozen run could carry): the host must stay inert
    const db = busMod.open(busFile);
    try { db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'rig', pause_mode = 'soft', pause_deadline_at = ? WHERE id = 'ops'").run(Date.now(), Date.now() + 8000); } finally { db.close(); }
    const l0 = linesNow(members[0]).length;
    await sleepFor(14_000); // past the stale deadline and several sweeps
    const l1 = linesNow(members[0]).length;
    const stale = carrierRow();
    check('off_host_inert_on_a_stale_soft_pause', withRo((d) => d.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'pause'").get().c) === 0 && withRo((d) => d.prepare('SELECT COUNT(*) AS c FROM pause_members').get().c) === 0 && stale.pause_escalated_at === null && stale.pause_trap_at === null,
      `pause rows ${withRo((d) => d.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'pause'").get().c)}, roster ${withRo((d) => d.prepare('SELECT COUNT(*) AS c FROM pause_members').get().c)}, escalated=${stale.pause_escalated_at}, trap=${stale.pause_trap_at}`);
    check('off_member_keeps_working', l1 > l0 && api.requests.every((r) => !r.order), `progress ${l0} → ${l1} lines over 14 s; no API request ever carried a pause order`);
    check('off_no_order_files', !fs.existsSync(path.join(orchHome, 'pause-orders')) || fs.readdirSync(path.join(orchHome, 'pause-orders')).length === 0, 'no pause order dropped');
    check('off_member_not_interrupted', alive(keepers[members[0].id].pid, keepers[members[0].id].start) && !app.events.some((e) => e.ev === 'turn-end' && e.ws === members[0].id), 'the member\'s turn was never interrupted/ended');
    check('rig_ran_to_completion', true, '');
  }
}
