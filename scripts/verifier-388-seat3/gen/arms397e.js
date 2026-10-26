// ===== seat 3 arms for #397 (spliced into a copy of the member's driver helpers) =====
const J = (x) => JSON.stringify(x);
const GRID9 = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85], [0.5, 0.15], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5]];
/** classify the 9 grid points of the visible .browser-holder by fixture colour (a|b|c|other) */
async function gridColors(ctx, name) {
  const r = await rectOf(ctx, '.browser-panel:not(.browser-panel-hidden) .browser-holder');
  if (!r) return { none: true, cls: [] };
  const img = grim(`${name}.png`);
  const cls = GRID9.map(([fx, fy]) => { const c = blockColor(img, Math.round(r.left + r.width * fx), Math.round(r.top + r.height * fy), 4); for (const k of ['a', 'b', 'c']) if (near(c, COLORS[k], 14)) return k; return 'other'; });
  return { none: false, cls, uniq: [...new Set(cls)].join('') };
}
/** Back to ONE blank-then-B HUMAN tab whatever earlier arms did (window.close(), refusals, leftovers): close every tab as the human, the last close leaves a fresh human tab. */
async function hardReset(ctx) {
  const { W1, ui } = ctx;
  await selectWs(ctx, W1); await openPane(ctx);
  for (let i = 0; i < 12; i++) {
    const r = await reg(ctx, W1);
    if (r.tabs.length === 1 && r.tabs[0].openedBy === 'human') break;
    await ui.eval(`window.orchestra.browserTabClose(${sel(W1.id)}, ${sel(r.tabs[0].id)}).then(() => true)`);
    await sleep(500);
  }
  const r = await reg(ctx, W1);
  if (!(r.tabs.length === 1 && r.tabs[0].openedBy === 'human')) throw new Error(`hardReset failed: ${brief(r)}`);
  await ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(ctx.URL.b)}).then(() => true)`);
  await waitFor(async () => /Tabs fixture B/.test((await reg(ctx, W1)).tabs[0]?.title ?? ''), 15000, 'the human tab to show B');
  await sleep(300);
  return reg(ctx, W1);
}
/** human tab on B (+ an agent tab on A when asked); returns the registry ids and agent-browser's own labels */
async function fresh(ctx, withAgent = true) {
  const { W1, URL: U } = ctx;
  await hardReset(ctx);
  if (withAgent) { await cli(ctx, W1, ['tab', 'new', U.a]); await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'agent tab A'); }
  const r = await reg(ctx, W1);
  const list = await abTabs(ctx, W1);
  return { r, human: r.tabs.find((t) => t.openedBy === 'human'), agent: r.tabs.find((t) => t.openedBy === 'agent'),
    abB: list.find((t) => /Tabs fixture B/.test(t.title)), abA: list.find((t) => /Tabs fixture A/.test(t.title)) };
}
async function survives(ctx, st, vt0) {
  const { W1 } = ctx; const r = await reg(ctx, W1); const vt = (await viewTargets(ctx)).length;
  return { ok: r.tabs.some((t) => t.id === st.human?.id) && /Tabs fixture B/.test(titled(r, /Tabs fixture B/)?.title ?? '') && vt === vt0, r, vt };
}
async function openRaw(ctx, W) {
  const ep = await hostCall(ctx, '/browser', { id: W.id, key: W.key }); const raw0 = await rawProxyClient(ep.wsUrl);
  const guard = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res({ timeout: true, error: { message: 'NO REPLY in 8 s' } }), 8000))]);
  return { ep, raw: { call: (m, a) => guard(raw0.call(m, a)), callOn: (sid, m, a) => guard(raw0.callOn(sid, m, a)), onEvent: raw0.onEvent, close: raw0.close } };
}
const targetOf = async (raw, re) => (await raw.call('Target.getTargets')).result?.targetInfos?.find((t) => re.test(t.title))?.targetId;
function httpGet(base, p, ms = 8000) {
  return new Promise((resolve) => {
    const u = new URL(p, base); const t0 = Date.now();
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', timeout: ms }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 300), ms: Date.now() - t0 })); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: '', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 'error', body: String(e.message), ms: Date.now() - t0 }));
    req.end();
  });
}
const refusedMsg = (m) => /opened by the user|may close only the tabs it opened|not_owner|not allowed|refus|not available|not found|wasn't found|Method not found|not supported/i.test(m ?? '');

const ARM_FNS = {
  // ── stale `tN` after an app restart (the member's engineered collision, my variants) ───────────────────────────────────────────────
  async stale(ctx) {
    const { W1, URL: U, ui } = ctx; const A = 'stale';
    await hardReset(ctx);
    await cli(ctx, W1, ['tab', 'new', U.a]); await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'page A tab');
    await cli(ctx, W1, ['tab', 'new', U.c]); await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture C/), 15000, 'page C tab');
    const before = await abTabs(ctx, W1); const oldA = before.find((t) => /Tabs fixture A/.test(t.title))?.tabId;
    const tabsFile = path.join(ctx.world.ohome, 'userData', 'orchestra', 'browser-tabs.json');
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(tabsFile, 'utf8')).workspaces?.[W1.id]?.tabs?.length === 3; } catch { return false; } }, 10000, 'the 3 tabs to reach browser-tabs.json');
    ui.close();
    try { process.kill(-ctx.app.pid, 'SIGKILL'); } catch {}
    await waitFor(() => { try { process.kill(ctx.app.pid, 0); return false; } catch { return true; } }, 15000, 'the SIGKILLed app to be gone');
    for (const p of listProcsByHome(ctx.world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(800);
    const layout = abLayout(ctx.world.ohome, XDG);
    if (/\/orch-ab-[0-9a-f]{8}$/.test(layout.socketDir)) fs.rmSync(layout.socketDir, { recursive: true, force: true });
    Object.assign(ctx, await bootApp(ctx.world, ctx.armDir, 'boot2'));
    await waitFor(() => ctx.ui.eval(`document.body.innerText.includes(${sel(W1.branch)})`), 60000, 'the seeded workspaces in the sidebar (boot 2)');
    await sleep(1500); await selectWs(ctx, W1); await openPane(ctx);
    await softWait(async () => (await reg(ctx, W1)).tabs.length === 3, 20000, 'the 3 tabs to be restored');
    const after = await abTabs(ctx, W1); const nowOldA = after.find((t) => t.tabId === oldA);
    const user = (await reg(ctx, W1)).tabs.find((t) => /Tabs fixture B/.test(t.title));
    clause(A, 'ctl/the-remembered-id-now-names-the-users-tab', /Tabs fixture B/.test(nowOldA?.title ?? '') && !!user, `the agent remembers A as ${oldA}; after the restart ${oldA} = ${J(nowOldA?.title)} (ids ${J(after.map((t) => [t.tabId, t.title.slice(-1)]))})`);
    const vt0 = (await viewTargets(ctx)).length;
    // every spelling of "close that stale id" must be refused; the user's tab must survive each
    const variants = [['plain', ['tab', 'close', oldA]], ['timeout-before', ['tab', 'close', '--timeout', '3000', oldA]], ['timeout-after', ['tab', 'close', oldA, '--timeout', '3000']], ['json', ['--json', 'tab', 'close', oldA]], ['dashdash', ['tab', 'close', '--', oldA]], ['two-refs', ['tab', 'close', oldA, after.find((t) => /Tabs fixture C/.test(t.title))?.tabId ?? 't9']]];
    for (const [nm, args] of variants) {
      const o = await cli(ctx, W1, args); await sleep(500); const r = await reg(ctx, W1);
      clause(A, `stale-id-close/${nm}-refused-and-the-users-tab-survives`, o.code !== 0 && /browser_tab_not_owner/.test(o.stderr + o.stdout) && !!titled(r, /Tabs fixture B/) && (await viewTargets(ctx)).length === vt0, `${args.join(' ')} → ${show(o)} · registry ${brief(r)}`);
    }
    const sw = await cli(ctx, W1, ['tab', oldA]);
    clause(A, 'stale-id-switch-says-the-users-tab-in-the-first-line', sw.code === 0 && /Tabs fixture B[^\n]*\(the user's\)/.test((sw.stdout.split('\n')[0] ?? '')), show(sw));
    const swj = await cli(ctx, W1, ['--json', 'tab', oldA]); let jd = null; try { jd = JSON.parse(swj.stdout.trim()); } catch {}
    clause(A, 'stale-id-switch-json-carries-openedBy-human', swj.code === 0 && jd?.data?.openedBy === 'human', show(swj));
    for (const [nm, args] of [['timeout-before', ['tab', '--timeout', '3000', oldA]], ['timeout-after', ['tab', oldA, '--timeout', '3000']]]) {
      const o = await cli(ctx, W1, args);
      if (o.code === 0) clause(A, `stale-id-switch/${nm}-is-annotated-too`, /\(the user's\)/.test(o.stdout), show(o));
      else console.log(`  INFO  [${A}] stale-id-switch/${nm}: agent-browser itself failed (${show(o)}) — nothing to annotate; not an Orchestra clause`);
    }
    const list = await cli(ctx, W1, ['tab', 'list']);
    clause(A, 'tab-list-after-restart-marks-every-tab', /Tabs fixture B[^\n]*\(the user's\)/.test(list.stdout) && /Tabs fixture A[^\n]*\(yours\)/.test(list.stdout) && /Tabs fixture C[^\n]*\(yours\)/.test(list.stdout), show(list));
  },

  // ── an agent closing the USER's tab by every route I can reach ─────────────────────────────────────────────────────────────────────
  async routes(ctx) {
    const { W1, URL: U } = ctx; const A = 'routes';
    // CONTROLS first (same routes, allowed target): each route family must be CAPABLE of closing the agent's own tab
    { const st = await fresh(ctx); const o = await cli(ctx, W1, ['tab', 'close', st.abA?.tabId ?? 't0']); await sleep(600);
      clause(A, 'ctl/cli-tab-close-closes-the-agents-own-tab', o.code === 0 && !(await reg(ctx, W1)).tabs.some((t) => t.openedBy === 'agent'), `${show(o)}`); }
    { const st = await fresh(ctx); const { ep, raw } = await openRaw(ctx, W1);
      try { const tid = await targetOf(raw, /Tabs fixture A/); const rep = await raw.call('Target.closeTarget', { targetId: tid }); await sleep(600);
        clause(A, 'ctl/raw-Target.closeTarget-closes-the-agents-own-tab', !!tid && !rep.error && !(await reg(ctx, W1)).tabs.some((t) => t.openedBy === 'agent'), `reply ${J(rep).slice(0, 160)}`); } finally { raw.close(); } }
    { const st = await fresh(ctx); const { ep, raw } = await openRaw(ctx, W1);
      try { const tid = await targetOf(raw, /Tabs fixture A/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId; const rep = sid ? await raw.callOn(sid, 'Page.close', {}) : null; await sleep(800);
        clause(A, 'ctl/root-session-Page.close-closes-the-agents-own-tab', !!sid && !rep?.error && !(await reg(ctx, W1)).tabs.some((t) => t.openedBy === 'agent'), `reply ${J(rep).slice(0, 160)}`); } finally { raw.close(); } }
    { const st = await fresh(ctx); const { ep, raw } = await openRaw(ctx, W1); const base = ep.wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '/');
      try { const tid = await targetOf(raw, /Tabs fixture A/); const h = await httpGet(base, `/json/close/${tid}`); await sleep(700);
        clause(A, 'ctl/http-json-close-closes-the-agents-own-tab-or-is-not-served', !(await reg(ctx, W1)).tabs.some((t) => t.openedBy === 'agent') || !String(h.status).startsWith('2'), `GET /json/close/<agent> → ${h.status} ${J(h.body).slice(0, 120)} (if 404/refused the route is simply not served: the user's-tab clause below is then trivially true)`); } finally { raw.close(); } }
    // THE USER'S TAB — each route on a fresh state
    const attack = async (name, runner) => {
      const st = await fresh(ctx); const vt0 = (await viewTargets(ctx)).length; let out;
      try { out = await runner(st); } catch (e) { out = { error: String(e.message) }; }
      await sleep(900); const s = await survives(ctx, st, vt0);
      clause(A, `${name}: the user's tab survives`, s.ok, `${out?.note ?? J(out).slice(0, 220)} · registry ${brief(s.r)} · page targets ${vt0}→${s.vt}`);
      return { st, out, s };
    };
    const refs = (st) => ({ lab: st.abB?.tabId, tid: st.abB?.targetId, label: st.abB?.label });
    // (1) CLI spellings, including agent-browser's documented numeric `tab [<n>]` index forms
    for (const [nm, mk] of [
      ['cli plain label', (r) => ['tab', 'close', r.lab]],
      ['cli --timeout before the ref', (r) => ['tab', 'close', '--timeout', '3000', r.lab]],
      ['cli --timeout after the ref', (r) => ['tab', 'close', r.lab, '--timeout', '3000']],
      ['cli --json', (r) => ['--json', 'tab', 'close', r.lab]],
      ['cli -- separator', (r) => ['tab', 'close', '--', r.lab]],
      ['cli targetId', (r) => ['tab', 'close', r.tid]],
      ['cli two refs (user first, agent second)', (r, st) => ['tab', 'close', r.lab, st.abA?.tabId ?? 't2']],
      ['cli two refs (AGENT first, user second)', (r, st) => ['tab', 'close', st.abA?.tabId ?? 't2', r.lab]],
      ['cli two refs (agent, user) behind --timeout', (r, st) => ['tab', 'close', '--timeout', '3000', st.abA?.tabId ?? 't2', r.lab]],
      ['cli numeric index 1', () => ['tab', 'close', '1']],
      ['cli numeric index 0', () => ['tab', 'close', '0']],
      ['cli numeric index 2', () => ['tab', 'close', '2']],
      ['cli uppercase id', (r) => ['tab', 'close', String(r.lab).toUpperCase()]],
      ['cli padded id', (r) => ['tab', 'close', ` ${r.lab} `]],
    ]) {
      const res = await attack(`${nm}`, async (st) => { const o = await cli(ctx, W1, mk(refs(st), st)); const lst = await cli(ctx, W1, ['tab', 'list']); const lied = o.code === 0 && /clos/i.test(o.stdout) ; return { note: `${show(o)} | list after: ${show(lst).slice(0, 220)}`, code: o.code, lied, listed: /Tabs fixture B/.test(lst.stdout) }; });
      clause(A, `${nm}: no lie — it is refused (rc≠0) or agent-browser's own list still has the user's tab (no desync)`, res.out?.code !== 0 || res.out?.listed === true, `rc ${res.out?.code}, said "closed": ${res.out?.lied}, user's tab still in \`tab list\`: ${res.out?.listed}`);
    }
    // (2) raw CDP at the proxy (what any same-uid client holding the token can do)
    await attack('raw Target.closeTarget root', async (st) => { const { raw } = await openRaw(ctx, W1); try { const tid = await targetOf(raw, /Tabs fixture B/); const rep = await raw.call('Target.closeTarget', { targetId: tid }); return { note: `reply ${J(rep).slice(0, 200)}`, refused: refusedMsg(rep?.error?.message) }; } finally { raw.close(); } });
    await attack('raw root-session Page.close', async (st) => { const { raw } = await openRaw(ctx, W1); try { const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const rep = await raw.callOn(att.result?.sessionId, 'Page.close', {}); return { note: `attach ${J(att).slice(0, 100)} → Page.close ${J(rep).slice(0, 180)}` }; } finally { raw.close(); } });
    await attack('raw Target.sendMessageToTarget(Page.close) on a root session', async (st) => { const { raw } = await openRaw(ctx, W1); try { const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: false }); const sid = att.result?.sessionId; const rep = await raw.call('Target.sendMessageToTarget', { sessionId: sid, message: JSON.stringify({ id: 1, method: 'Page.close' }) }); return { note: `attach(flatten:false) ${J(att).slice(0, 90)} → sendMessageToTarget ${J(rep).slice(0, 180)}` }; } finally { raw.close(); } });
    await attack('raw Browser.close', async () => { const { raw } = await openRaw(ctx, W1); try { const rep = await raw.call('Browser.close', {}); return { note: `reply ${J(rep).slice(0, 200)}` }; } finally { raw.close(); } });
    await attack('raw Target.attachToBrowserTarget + Browser.close', async () => { const { raw } = await openRaw(ctx, W1); try { const att = await raw.call('Target.attachToBrowserTarget', {}); const sid = att.result?.sessionId; const rep = sid ? await raw.callOn(sid, 'Browser.close', {}) : null; return { note: `browser target ${J(att).slice(0, 100)} → Browser.close ${J(rep).slice(0, 160)}` }; } finally { raw.close(); } });
    await attack('raw Target.disposeBrowserContext / closeBrowser-ish', async (st) => { const { raw } = await openRaw(ctx, W1); try { const ctxs = await raw.call('Target.getBrowserContexts', {}); const id0 = ctxs.result?.browserContextIds?.[0]; const rep = id0 ? await raw.call('Target.disposeBrowserContext', { browserContextId: id0 }) : { note: 'no context listed' }; return { note: `contexts ${J(ctxs).slice(0, 120)} → dispose ${J(rep).slice(0, 160)}` }; } finally { raw.close(); } });
    await attack('http /json/close/<user targetId>', async (st) => { const { ep, raw } = await openRaw(ctx, W1); const base = ep.wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '/'); try { const tid = await targetOf(raw, /Tabs fixture B/); const a = await httpGet(base, `/json/close/${tid}`); const tok = (/\/devtools\/browser\/([^/?]+)/.exec(ep.wsUrl) ?? [])[1]; const b = tok ? await httpGet(base, `/${tok}/json/close/${tid}`) : null; return { note: `GET /json/close → ${a.status} ${J(a.body).slice(0, 100)}; token-prefixed → ${b?.status} ${J(b?.body ?? '').slice(0, 100)}` }; } finally { raw.close(); } });
    // (3) a CHILD session of the user's tab (worker + cross-site iframe) — member covers Page.close; I add Target.closeTarget(child) and sendMessageToTarget
    {
      const st = await fresh(ctx, true); const vt0 = (await viewTargets(ctx)).length; const humanId = st.human?.id;
      const { ep, raw } = await openRaw(ctx, W1); const evs = []; raw.onEvent((m) => evs.push(m));
      let note = '';
      try {
        await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(humanId ?? '')}).then(() => true)`);
        const tid = await targetOf(raw, /Tabs fixture B/);
        const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const rootSid = att.result?.sessionId;
        if (rootSid) await raw.callOn(rootSid, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.frame)}).then(() => true)`);
        await softWait(async () => evs.some((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid), 15000, 'a child session'); await sleep(700);
        const kids = evs.filter((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid).map((m) => ({ sid: m.params?.sessionId, tid: m.params?.targetInfo?.targetId, type: m.params?.targetInfo?.type }));
        const outs = [];
        for (const k of kids) {
          outs.push([k.type, 'child Page.close', J(await raw.callOn(k.sid, 'Page.close', {})).slice(0, 110)]);
          outs.push([k.type, 'child Browser.close', J(await raw.callOn(k.sid, 'Browser.close', {})).slice(0, 110)]);
          outs.push([k.type, 'child Target.closeTarget(self)', J(await raw.callOn(k.sid, 'Target.closeTarget', { targetId: k.tid })).slice(0, 110)]);
          outs.push([k.type, 'root closeTarget(child targetId)', J(await raw.call('Target.closeTarget', { targetId: k.tid })).slice(0, 110)]);
          outs.push([k.type, 'child sendMessageToTarget(Page.close)', J(await raw.callOn(k.sid, 'Target.sendMessageToTarget', { sessionId: k.sid, message: JSON.stringify({ id: 9, method: 'Page.close' }) })).slice(0, 110)]);
        }
        outs.push(['root', 'sendMessageToTarget(root, Page.close)', J(await raw.callOn(rootSid, 'Target.sendMessageToTarget', { sessionId: rootSid, message: JSON.stringify({ id: 10, method: 'Page.close' }) })).slice(0, 110)]);
        note = `${kids.length} child session(s) ${kids.map((k) => k.type).join(',') || 'NONE'}; ${outs.map((o) => o.join(': ')).join(' | ')}`;
        clause(A, 'ctl/a-child-session-exists-for-the-child-attacks', kids.length > 0, note.slice(0, 200));
      } finally { raw.close(); }
      await sleep(900); const s = await survives({ ...ctx }, { human: { id: humanId } }, vt0);
      const r = await reg(ctx, W1); const alive = r.tabs.some((t) => t.id === humanId);
      clause(A, 'child-session/worker+iframe close attempts: the user\'s tab survives', alive, `${note.slice(0, 700)} · registry ${brief(r)}`);
    }
    // (4) page-JS `window.close()` in the user's tab — ACCEPTED GAP per the nomination; measured here, not asserted
    {
      const st = await fresh(ctx); const vt0 = (await viewTargets(ctx)).length;
      await cli(ctx, W1, ['tab', st.abB?.tabId]);
      const o = await cli(ctx, W1, ['eval', 'window.close(); "sent"']); await sleep(1200);
      const s = await survives(ctx, st, vt0);
      console.log(`  INFO  [${A}] page-JS window.close() in the user's tab (accepted-gap in the nomination): ${show(o)} → user's tab survived=${s.ok}; registry ${brief(s.r)}`);
    }
  },

  // ── the cap is shared with the human; real clicks on +, ×; raw / HTTP creation routes ───────────────────────────────────────────────
  async capshare(ctx) {
    const { W1, ui, URL: U } = ctx; const A = 'capshare';
    await hardReset(ctx);
    const vtc = async () => (await viewTargets(ctx)).length;
    for (let i = 0; i < 4; i++) { await clickSel(ctx, '.browser-tab-new'); await sleep(450); }
    let r = await reg(ctx, W1);
    clause(A, 'ctl/the-human-opened-4-more-tabs-with-real-clicks', r.tabs.length === 5 && r.tabs.every((t) => t.openedBy === 'human') && (await vtc()) === 5, `registry ${brief(r)} · page targets ${await vtc()}`);
    const outs = []; for (let i = 0; i < 3; i++) outs.push(await cli(ctx, W1, ['tab', 'new', U.c]));
    r = await reg(ctx, W1);
    clause(A, 'ctl/the-agent-fills-the-remaining-3-slots', outs.every((o) => o.code === 0) && r.tabs.length === 8 && r.tabs.filter((t) => t.openedBy === 'agent').length === 3 && (await vtc()) === 8, `rc ${outs.map((o) => o.code).join('')} · registry ${brief(r)} · page targets ${await vtc()}`);
    await softWait(async () => { const g = await gridColors(ctx, 'cap-0-settle'); return !g.none && g.uniq.length === 1 && 'abc'.includes(g.uniq); }, 12000, 'the visible page to finish loading');
    const g0 = await gridColors(ctx, 'cap-0-eight');
    const over = await cli(ctx, W1, ['tab', 'new', U.a]); await sleep(600);
    clause(A, 'agent-9th-via-cli-is-refused-with-the-reason', over.code !== 0 && /Tab limit reached: a workspace holds at most 8/.test(over.stderr + over.stdout), show(over));
    const { ep, raw } = await openRaw(ctx, W1); const base = ep.wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '/');
    let ct, hn;
    try { ct = await raw.call('Target.createTarget', { url: U.a }); } finally { raw.close(); }
    hn = await httpGet(base, `/json/new?${encodeURIComponent(U.a)}`); const hn2 = await httpGet(base, `/json/new?url=${encodeURIComponent(U.a)}`);
    await sleep(700);
    clause(A, 'agent-9th-via-raw-Target.createTarget-is-refused', !!ct?.error && /Tab limit|limit/i.test(ct.error.message ?? ''), `reply ${J(ct).slice(0, 220)}`);
    r = await reg(ctx, W1);
    clause(A, 'agent-9th-via-http-json-new-creates-nothing', r.tabs.length === 8 && (await vtc()) === 8, `GET /json/new → ${hn.status} ${J(hn.body).slice(0, 90)} · ?url= → ${hn2.status} ${J(hn2.body).slice(0, 90)} · registry ${r.tabs.length} tabs · page targets ${await vtc()}`);
    await softWait(async () => (await noticeText(ctx)) === null, 14000, 'the agent-swap notice to lapse (it overlays the + button; that defect is the `notice` arm)');
    await clickSel(ctx, '.browser-tab-new'); await sleep(900);
    const notice = await ctx.ui.eval(`document.querySelector('.browser-tab-notice')?.textContent ?? null`);
    r = await reg(ctx, W1);
    clause(A, 'human-9th-via-the-+-button-is-refused-with-a-visible-notice', /Tab limit/.test(notice ?? '') && r.tabs.length === 8 && (await vtc()) === 8, `notice ${J(notice)} · registry ${r.tabs.length} · page targets ${await vtc()}`);
    const g1 = await gridColors(ctx, 'cap-1-after-refusals');
    clause(A, 'refusals-leave-the-screen-as-it-was-no-leaked-view-painted', g0.uniq === g1.uniq && !g1.none, `holder 9-pt colours before ${g0.uniq} after ${g1.uniq}`);
    // free a slot with a REAL click on the × of the last human-opened (blank) tab; the agent can open again, then is refused again
    const humanBlank = r.tabs.filter((t) => t.openedBy === 'human').slice(-1)[0];
    const xi = await ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.tabId === ${sel(humanBlank.id)})`);
    await clickSel(ctx, '.browser-tab-close', xi); await sleep(800);
    r = await reg(ctx, W1);
    const again = await cli(ctx, W1, ['tab', 'new', U.b]); await sleep(700);
    const r2 = await reg(ctx, W1); const over2 = await cli(ctx, W1, ['tab', 'new', U.a]);
    clause(A, 'a-freed-slot-is-reusable-then-refused-again', r.tabs.length === 7 && again.code === 0 && r2.tabs.length === 8 && over2.code !== 0 && (await vtc()) === 8, `after × click ${r.tabs.length} tabs · agent open rc ${again.code} → ${r2.tabs.length} · next rc ${over2.code} · page targets ${await vtc()}`);
  },

  // ── 8 tabs with agent badges: does every × and the + still hit itself? (the real click on + at the cap closed a tab in capshare) ────────
  async strip8(ctx) {
    const { W1, ui, URL: U } = ctx; const A = 'strip8';
    const geom = () => ui.eval(`(() => {
      const tabs = [...document.querySelectorAll('.browser-tab')].map((t, i) => { const c = t.querySelector('.browser-tab-close'); const r = t.getBoundingClientRect(); const cr = c.getBoundingClientRect(); const top = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
        return { i, by: t.dataset.openedBy, tab: [Math.round(r.left), Math.round(r.right)], x: [Math.round(cr.left), Math.round(cr.right)], xHitsSelf: !!top && (top === c || c.contains(top)), xTop: top ? String(top.className || top.tagName).slice(0, 40) : null, clipped: cr.right > r.right + 0.5 }; });
      const p = document.querySelector('.browser-tab-new'); const pr = p.getBoundingClientRect(); const ptop = document.elementFromPoint(pr.left + pr.width / 2, pr.top + pr.height / 2); const strip = document.querySelector('.browser-tabs'); const sr = strip.getBoundingClientRect();
      return { n: tabs.length, tabs, plus: { rect: [Math.round(pr.left), Math.round(pr.right)], hitsSelf: !!ptop && (ptop === p || p.contains(ptop)), top: ptop ? String(ptop.className || ptop.tagName).slice(0, 40) : null, insideStrip: pr.right <= sr.right + 0.5 }, strip: [Math.round(sr.left), Math.round(sr.right)], scrollW: strip.scrollWidth, clientW: strip.clientWidth };
    })()`);
    const verdict = (g) => ({ xBad: g.tabs.filter((t) => !t.xHitsSelf || t.clipped).map((t) => `tab${t.i}(${t.by}) x=${t.x} tab=${t.tab} clipped=${t.clipped} top=${t.xTop}`), plusOk: g.plus.hitsSelf && g.plus.insideStrip, overflow: g.scrollW > g.clientW });
    for (const [label, agentFirst] of [['agent tabs LAST (5 human + 3 agent)', false], ['agent tabs FIRST (3 agent + 5 human)', true]]) {
      await hardReset(ctx);
      const openAgent = async () => { for (let i = 0; i < 3; i++) await cli(ctx, W1, ['tab', 'new', U.c]); };
      const openHuman = async () => { for (let i = 0; i < 4; i++) { await clickSel(ctx, '.browser-tab-new'); await sleep(450); } };
      if (agentFirst) { await openAgent(); await openHuman(); } else { await openHuman(); await openAgent(); }
      await softWait(async () => (await noticeText(ctx)) === null, 14000, 'the notice to lapse');
      const r = await reg(ctx, W1); const g = await geom(); const v = verdict(g);
      grim(`strip8-${agentFirst ? 'agentfirst' : 'agentlast'}.png`);
      clause(A, `ctl/${label}: eight tabs, no notice`, r.tabs.length === 8 && g.n === 8 && (await noticeText(ctx)) === null, `registry ${brief(r)}`);
      clause(A, `${label}: every × hits itself and is inside its tab`, v.xBad.length === 0, v.xBad.length ? `BAD: ${J(v.xBad)}` : `8 × all hit themselves`);
      clause(A, `${label}: the + hits itself and is inside the strip`, v.plusOk, `+ rect ${J(g.plus.rect)} strip ${J(g.strip)} → hits ${J(g.plus.top)} inside=${g.plus.insideStrip}`);
      clause(A, `${label}: the strip does not overflow its box`, !v.overflow, `scrollWidth ${g.scrollW} vs clientWidth ${g.clientW}`);
      const before = await reg(ctx, W1);
      await clickSel(ctx, '.browser-tab-new'); await sleep(900);
      const after = await reg(ctx, W1); const nt = await ui.eval(`document.querySelector('.browser-tab-notice')?.textContent ?? null`);
      clause(A, `${label}: a real click on + at the cap shows the refusal and closes nothing`, after.tabs.length === 8 && /Tab limit/.test(nt ?? ''), `tabs ${before.tabs.length}→${after.tabs.length}; notice ${J(nt)}; closed: ${J(before.tabs.filter((t) => !after.tabs.some((x) => x.id === t.id)).map((t) => `${t.id}(${t.openedBy})`))}`);
    }
  },

  // ── the swap notice must not cover or move any human control ─────────────────────────────────────────────────────────────────────────
  async notice(ctx) {
    const { W1, ui, URL: U } = ctx; const A = 'notice';
    await hardReset(ctx);
    await clickSel(ctx, '.browser-tab-new'); await sleep(600);
    const r0 = await reg(ctx, W1); const second = r0.tabs[1];
    await ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.c)}).then(() => true)`);
    await softWait(async () => /Tabs fixture C/.test((await reg(ctx, W1)).tabs[1]?.title ?? ''), 15000, 'the 2nd human tab to show C');
    await cli(ctx, W1, ['tab', 'new', U.a]); await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'agent tab');
    await softWait(async () => (await noticeText(ctx)) !== null, 6000, 'the notice');
    const up = await noticeText(ctx);
    grim('notice-up.png');
    // hit-test the centre of every human control: the notice must be NEITHER above it NOR overlapping its box
    const probe = () => ui.eval(`(() => {
      const nb = document.querySelector('.browser-agent-switch'); const nr = nb ? nb.getBoundingClientRect() : null;
      const sels = ['.browser-tab-new', '.browser-nav-btn[aria-label="Back"]', '.browser-nav-btn[aria-label="Forward"]', '.browser-nav-btn[aria-label="Reload"]', '.browser-url-input', '.browser-design-btn'];
      const out = [];
      const check = (el, name) => { if (!el) { out.push({ name, missing: true }); return; } const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = document.elementFromPoint(cx, cy);
        out.push({ name, top: top ? (top.className || top.tagName) : null, hit: !!top && (top === el || el.contains(top)), coveredByNotice: !!(top && nb && nb.contains(top)), overlaps: !!(nr && !(r.right <= nr.left || r.left >= nr.right || r.bottom <= nr.top || r.top >= nr.bottom)) }); };
      document.querySelectorAll('.browser-tab').forEach((t, i) => { check(t.querySelector('.browser-tab-close'), 'tab' + i + ' ×'); if (t.dataset.openedBy === 'human') check(t.querySelector('.browser-tab-label'), 'tab' + i + ' label'); });
      for (const s of sels) check(document.querySelector(s), s);
      return { notice: !!nb, rect: nr && { l: Math.round(nr.left), t: Math.round(nr.top), r: Math.round(nr.right), b: Math.round(nr.bottom) }, out };
    })()`);
    const p = await probe();
    const isStrip = (o) => /^tab\d+ (×|label)$/.test(o.name) || o.name === '.browser-tab-new';
    const badStrip = p.out.filter((o) => isStrip(o) && o.missing === undefined && (!o.hit || o.coveredByNotice));
    const badTool = p.out.filter((o) => !isStrip(o) && o.missing === undefined && (!o.hit || o.coveredByNotice));
    clause(A, 'ctl/the-notice-is-up-and-there-are-human-controls-to-test', !!up && p.notice && p.out.length >= 8, `notice ${J(up)} rect ${J(p.rect)} · ${p.out.length} controls probed`);
    clause(A, 'no-tab-no-x-no-plus-is-under-the-notice-every-centre-hits-its-own-control', badStrip.length === 0, badStrip.length ? `COVERED/MISSED: ${J(badStrip)}` : `${p.out.filter(isStrip).length} strip controls, all centres hit themselves`);
    console.log(`  INFO  [${A}] toolbar controls under the notice (measured; the member's design says harmless to mis-click): ${badTool.length ? J(badTool.map((o) => ({ name: o.name, top: o.top }))) : 'none covered'}`);
    // a REAL click on the human's + while the notice is up: it must open a tab (it must not land on the notice's « Back » or on nothing)
    { const b0 = await reg(ctx, W1); const noticeStillUp = (await noticeText(ctx)) !== null;
      const topAtPlus = await ui.eval(`(() => { const e = document.querySelector('.browser-tab-new'); const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t ? (t.className || t.tagName) : null; })()`);
      await clickSel(ctx, '.browser-tab-new'); await sleep(900); const b1 = await reg(ctx, W1);
      clause(A, 'a-real-click-on-the-+-under-the-notice-opens-a-tab-and-does-not-go-Back', noticeStillUp && b1.tabs.length === b0.tabs.length + 1, `notice up ${noticeStillUp}; element under the + centre: ${J(topAtPlus)}; before ${brief(b0)} → after ${brief(b1)}`);
      grim('notice-after-plus-click.png');
      await softWait(async () => (await noticeText(ctx)) === null, 14000, 'the notice to lapse');
      // restore the 3-tab shape for the × test: close the extra blank tab with a real click once nothing overlays it
      const extra = b1.tabs.find((t) => !b0.tabs.some((x) => x.id === t.id));
      if (extra) { const xi = await ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.tabId === ${sel(extra.id)})`); if (xi >= 0) { await clickSel(ctx, '.browser-tab-close', xi); await sleep(700); } }
      await cli(ctx, W1, ['tab', 'new', U.a]); await softWait(async () => (await noticeText(ctx)) !== null, 6000, 'the notice again');
    }
    // a REAL click on a human tab's × while the notice is up closes THAT tab only
    const idx = await ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.tabId === ${sel(second.id)})`);
    const before = await reg(ctx, W1);
    await clickSel(ctx, '.browser-tab-close', idx); await sleep(900);
    const after = await reg(ctx, W1);
    clause(A, 'a-real-click-on-a-human-tab-x-under-the-notice-closes-that-tab-only', after.tabs.length === before.tabs.length - 1 && !after.tabs.some((t) => t.id === second.id) && before.tabs.filter((t) => t.id !== second.id).every((t) => after.tabs.some((x) => x.id === t.id)), `before ${brief(before)} → after ${brief(after)}`);
  },

  // ── a background / archived workspace's agent never attaches or shows a view ───────────────────────────────────────────────────────
  async bg(ctx) {
    const { W1, W2, W3, URL: U, ui } = ctx; const A = 'bg';
    await hardReset(ctx);
    const g0 = await gridColors(ctx, 'bg-0-w1'); const w1r0 = await reg(ctx, W1);
    clause(A, 'ctl/w1-on-screen-shows-only-B', !g0.none && g0.uniq === 'b', `holder 9-pt colours ${g0.uniq}; W1 ${brief(w1r0)}`);
    const w2h0 = await reg(ctx, W2);
    const steps = [];
    const run = async (label, args, o) => { const r = await cli(ctx, W2, args, o); steps.push(`${label}:${r.code}${r.code ? '(' + (r.stderr || r.stdout).trim().slice(0, 90) + ')' : ''}`); return r; };
    await run('open', ['open', U.c]); await run('tab new', ['tab', 'new', U.a]);
    await softWait(async () => (await reg(ctx, W2)).tabs.length === 2, 15000, 'W2 two tabs');
    const labA = await abLabel(ctx, W2, /Tabs fixture A/); const labC = await abLabel(ctx, W2, /Tabs fixture C/);
    await run('switch A', ['tab', labA ?? 't0']); await run('eval', ['eval', 'document.title']); await run('get url', ['get', 'url']);
    await run('switch C', ['tab', labC ?? 't0']); await run('snapshot', ['snapshot', '-i']);
    const shot = path.join(ctx.world.fakeHome, 'bg-shot.png'); await run('screenshot', ['screenshot', shot], { timeoutMs: 45000 }); await run('switch A again', ['tab', labA ?? 't0']);
    // raw: the agent's own proxy client asks for the front itself
    const { raw } = await openRaw(ctx, W2); let fr = [];
    try { const tid = await targetOf(raw, /Tabs fixture A/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId;
      fr.push(J(await raw.call('Target.activateTarget', { targetId: tid })).slice(0, 80)); if (sid) fr.push(J(await raw.callOn(sid, 'Page.bringToFront', {})).slice(0, 80)); } finally { raw.close(); }
    await sleep(900);
    const w2r = await reg(ctx, W2); const w1r1 = await reg(ctx, W1); const g1 = await gridColors(ctx, 'bg-1-w1-after');
    const vt = (await viewTargets(ctx)).length;
    clause(A, 'ctl/the-background-agent-really-worked-screenshot-aside', steps.filter((s) => !s.startsWith('screenshot')).every((s) => /:0$/.test(s)) && w2r.tabs.length === 2, `steps ${steps.join(' ')}; raw front ${fr.join(' / ')}; W2 ${brief(w2r)}`);
    clause(A, 'background-agent-never-activates-its-tab-the-users-stays-active', w2r.tabs.find((t) => t.active)?.openedBy === 'human' && w2r.agentSwitch === null, `W2 ${brief(w2r)} agentSwitch ${J(w2r.agentSwitch)} (incl. raw Target.activateTarget + Page.bringToFront)`);
    clause(A, 'the-focused-workspace-screen-and-registry-are-untouched', g1.uniq === 'b' && JSON.stringify(w1r1) === JSON.stringify(w1r0) && (await noticeText(ctx)) === null, `holder 9-pt colours ${g1.uniq} (only B); W1 registry unchanged ${JSON.stringify(w1r1) === JSON.stringify(w1r0)}; notice ${J(await noticeText(ctx))}`);
    clause(A, 'one-native-view-per-tab-no-extra-view', vt === w1r1.tabs.length + w2r.tabs.length, `page targets ${vt} = W1 ${w1r1.tabs.length} + W2 ${w2r.tabs.length}`);
    // ARCHIVED workspace: build a panel for W3 as a background agent, archive it, then every agent command must be refused and create nothing
    await cli(ctx, W3, ['open', U.c]); await cli(ctx, W3, ['tab', 'new', U.a]);
    await softWait(async () => (await reg(ctx, W3)).tabs.length === 2, 15000, 'W3 two tabs');
    const vtBefore = (await viewTargets(ctx)).length;
    const arch = await ui.eval(`window.orchestra.archiveWorkspace(${sel(W3.id)}).then(() => 'ok', (e) => 'ERR ' + e.message)`);
    await sleep(2500);
    const vtAfter = (await viewTargets(ctx)).length; const w3reg = await reg(ctx, W3);
    clause(A, 'archive-destroys-the-archived-workspaces-views', arch === 'ok' && vtAfter === vtBefore - 2 && w3reg.tabs.length === 0, `archive ${arch} · page targets ${vtBefore}→${vtAfter} (want −2) · W3 registry ${brief(w3reg)}`);
    const arc = [];
    for (const [nm, args] of [['tab new', ['tab', 'new', U.a]], ['open', ['open', U.b]], ['eval', ['eval', '1+1']], ['tab list', ['tab', 'list']], ['screenshot', ['screenshot', path.join(ctx.world.fakeHome, 'arch-shot.png')]], ['click', ['click', '@e1']]]) { const r = await cli(ctx, W3, args, { timeoutMs: 45000 }); arc.push({ nm, r }); }
    await sleep(900);
    const vtEnd = (await viewTargets(ctx)).length; const w3end = await reg(ctx, W3);
    clause(A, 'an-archived-workspaces-agent-is-refused-on-every-command', arc.every((a) => a.r.code !== 0), arc.map((a) => `${a.nm}:rc${a.r.code}:${(a.r.stderr || a.r.stdout).trim().slice(0, 70)}`).join(' | '));
    clause(A, 'and-resurrects-no-panel-no-view', vtEnd === vtAfter && w3end.tabs.length === 0, `page targets ${vtAfter}→${vtEnd} · W3 registry ${brief(w3end)} (a resurrected panel would create a blank view)`);
    const g2 = await gridColors(ctx, 'bg-2-w1-end');
    clause(A, 'ctl/w1-still-shows-only-B-at-the-end', g2.uniq === 'b', `holder 9-pt colours ${g2.uniq}`);
  },

  // ── LAST: destructive CDP verbs that are not closes but kill the user's tab; measured, never asserted (INFO) ──────────────────────
  async crash(ctx) {
    const { W1 } = ctx; const A = 'crash';
    const st = await fresh(ctx); const vt0 = (await viewTargets(ctx)).length;
    const { raw } = await openRaw(ctx, W1); const outs = [];
    try { const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId;
      outs.push(['Page.crash', J(await raw.callOn(sid, 'Page.crash', {})).slice(0, 110)]); } finally { raw.close(); }
    await sleep(1500); const s = await survives(ctx, st, vt0);
    const live = await (async () => { try { const o = await oracle(ctx, ctx.URL.b, 4000); try { return await Promise.race([o.eval('1+1'), new Promise((r) => setTimeout(() => r('NO ANSWER in 4 s (renderer dead)'), 4000))]); } finally { o.close(); } } catch (e) { return `target gone/unreachable: ${e.message}`; } })();
    console.log(`  INFO  [${A}] Page.crash on the user's tab via the proxy (not a close; measured): ${outs.map((o) => o.join(' → ')).join(' | ')} → user's tab still in registry=${s.r.tabs.some((t) => t.id === st.human?.id)}; page targets ${vt0}→${s.vt}; the page's own eval(1+1) → ${J(live)}`);
    const { raw: r2 } = await openRaw(ctx, W1);
    try { const rep = await r2.call('Browser.crash', {}); console.log(`  INFO  [${A}] Browser.crash via the proxy: ${J(rep).slice(0, 160)}`); } finally { r2.close(); }
    await sleep(1500);
    clause(A, 'the-app-is-still-alive-after-the-crash-verbs', await ctx.ui.eval('1+1').then((v) => v === 2, () => false), 'renderer eval(1+1)');
  },
  // ── seat 3 (final tip): renderer-killers on the USER's tab, root + child sessions — asserted now that the member gated them ───────────────
  async killers(ctx) {
    const { W1, URL: U } = ctx; const A = 'killers';
    const liveOn = async (url) => { try { const o = await oracle(ctx, url, 5000); try { return await Promise.race([o.eval('1+1'), new Promise((r) => setTimeout(() => r('NO ANSWER'), 4000))]); } finally { o.close(); } } catch (e) { return `ERR ${String(e.message).slice(0, 60)}`; } };
    const isRefused = (rep) => !!rep?.error && /refused|opened by the user|may only destroy/i.test(rep.error.message ?? '');
    // root session
    {
      const st = await fresh(ctx); const vt0 = (await viewTargets(ctx)).length; const { raw } = await openRaw(ctx, W1); const out = {};
      try {
        const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId;
        out.crash = await raw.callOn(sid, 'Page.crash', {}); out.term = await raw.callOn(sid, 'Runtime.terminateExecution', {});
        out.viaSend = await raw.callOn(sid, 'Target.sendMessageToTarget', { sessionId: sid, message: JSON.stringify({ id: 21, method: 'Page.crash' }) });
      } finally { raw.close(); }
      await sleep(1500); const live = await liveOn(U.b); const s = await survives(ctx, st, vt0);
      clause(A, 'root-session-Page.crash-and-Runtime.terminateExecution-on-the-users-tab-are-refused', isRefused(out.crash) && isRefused(out.term), `crash ${J(out.crash).slice(0, 150)} | terminate ${J(out.term).slice(0, 150)}`);
      console.log(`  INFO  [${A}] Target.sendMessageToTarget(Page.crash) on a root session: ${J(out.viaSend).slice(0, 160)}`);
      clause(A, 'the-users-tab-renderer-is-alive-after-them', live === 2 && s.ok, `eval(1+1) in the user's page → ${J(live)}; registry/targets ok=${s.ok} (${brief(s.r)}, page targets ${vt0}→${s.vt})`);
    }
    // positive control: on the AGENT's own tab the same methods are NOT refused (the gate is by ownership, not a blanket ban)
    {
      const st = await fresh(ctx); const { raw } = await openRaw(ctx, W1); let rep;
      try { const tid = await targetOf(raw, /Tabs fixture A/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); rep = await raw.callOn(att.result?.sessionId, 'Runtime.terminateExecution', {}); } finally { raw.close(); }
      clause(A, 'ctl/terminateExecution-on-the-agents-own-tab-is-not-refused', !!rep && !isRefused(rep), `reply ${J(rep).slice(0, 160)}`);
    }
    // child sessions (worker + cross-site iframe) of the user's tab
    {
      const st = await fresh(ctx, true); const humanId = st.human?.id; const { raw } = await openRaw(ctx, W1); const evs = []; raw.onEvent((m) => evs.push(m)); const outs = [];
      try {
        await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(humanId ?? '')}).then(() => true)`);
        const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const rootSid = att.result?.sessionId;
        await raw.callOn(rootSid, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.frame)}).then(() => true)`);
        await softWait(async () => evs.some((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid), 15000, 'a child session'); await sleep(800);
        const kids = evs.filter((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid).map((m) => ({ sid: m.params?.sessionId, type: m.params?.targetInfo?.type }));
        clause(A, 'ctl/child-sessions-exist', kids.length > 0, kids.map((k) => k.type).join(',') || 'NONE');
        for (const k of kids) for (const m of ['Page.crash', 'Runtime.terminateExecution']) outs.push({ type: k.type, m, rep: await raw.callOn(k.sid, m, {}) });
      } finally { raw.close(); }
      await sleep(1500); const live = await liveOn(U.frame); const r = await reg(ctx, W1);
      const gone = (rep) => /Session with given id not found/i.test(rep?.error?.message ?? ''); clause(A, 'child-sessions-Page.crash-and-terminateExecution-are-never-accepted (refused, or the session is already gone)', outs.length > 0 && outs.every((o) => isRefused(o.rep) || gone(o.rep)) && outs.some((o) => isRefused(o.rep)), outs.map((o) => `${o.type}:${o.m.split('.')[1]}→${isRefused(o.rep) ? 'refused' : J(o.rep).slice(0, 60)}`).join(' | '));
      clause(A, 'the-users-tab-is-alive-after-the-child-session-attempts', live === 2 && r.tabs.some((t) => t.id === humanId), `eval(1+1) → ${J(live)}; ${brief(r)}`);
    }
    // other ways to kill a renderer that are NOT in the gated list: navigate the user's tab to a renderer-killing chrome:// URL through the proxy
    for (const url of ['chrome://crash', 'chrome://kill', 'chrome://hang']) {
      const st = await fresh(ctx); const vt0 = (await viewTargets(ctx)).length; const { raw } = await openRaw(ctx, W1); let rep;
      try { const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); rep = await raw.callOn(att.result?.sessionId, 'Page.navigate', { url }); } finally { raw.close(); }
      await sleep(2500); const live = await liveOn(U.b); const s = await survives(ctx, st, vt0); const r = await reg(ctx, W1);
      const dead = live !== 2;
      clause(A, `Page.navigate-${url}-on-the-users-tab-does-not-kill-its-renderer`, !dead, `reply ${J(rep).slice(0, 140)}; eval(1+1) on the user's page → ${J(live)}; registry ${brief(r)}; ${dead ? 'RENDERER KILLED — a route past the gate' : 'alive'}`);
    }
    clause(A, 'the-app-is-still-alive', await ctx.ui.eval('1+1').then((v) => v === 2, () => false), 'renderer eval(1+1)');
  },

  // ── seat 3 (final tip, #396 merged): who owns a tab that a popup / target=_blank opened ───────────────────────────────────────────────
  async popuptab(ctx) {
    const { W1 } = ctx; const A = 'popuptab'; const PU = `${ctx.FIX}/popups-opener.html`;
    const blankTab = (r) => r.tabs.find((t) => /Popups fixture blank/.test(t.title));
    const refFor = (snap) => (/link "open in a new tab"[^\n]*ref=(e\d+)/.exec(snap) || [])[1];
    // H — a HUMAN click (trusted CDP click on the page) in the human's own tab
    {
      await hardReset(ctx);
      await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(PU)}).then(() => true)`);
      await waitFor(async () => /Popups fixture opener/.test((await reg(ctx, W1)).tabs[0]?.title ?? ''), 15000, 'the opener page in the human tab'); await sleep(500);
      const o = await oracle(ctx, PU, 8000); const pos = await o.eval(`(() => { const r = document.getElementById('blank').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); await o.click(pos.x, pos.y); o.close();
      await softWait(async () => !!blankTab(await reg(ctx, W1)), 15000, 'the popup tab'); const r = await reg(ctx, W1); const bt = blankTab(r);
      clause(A, 'ctl/a-human-click-on-target=_blank-opens-a-tab-owned-by-the-human', !!bt && bt.openedBy === 'human', `registry ${brief(r)}`);
      const lst = await cli(ctx, W1, ['tab', 'list']); const line = lst.stdout.split('\n').find((l) => /Popups fixture blank/.test(l)) ?? '';
      clause(A, 'tab-list-marks-the-popup-tab-as-the-users', /\(the user's\)/.test(line), `tab list line ${J(line)}`);
      const ab = (await abTabs(ctx, W1)).find((t) => /Popups fixture blank/.test(t.title));
      const vt0 = (await viewTargets(ctx)).length;
      const c1 = await cli(ctx, W1, ['tab', 'close', ab?.tabId ?? 't9']); await sleep(500);
      const c2 = await cli(ctx, W1, ['tab', 'close', String(ab?.tabId ?? 't9').toUpperCase()]); await sleep(500);
      const { raw } = await openRaw(ctx, W1); let rc; try { const tid = await targetOf(raw, /Popups fixture blank/); rc = await raw.call('Target.closeTarget', { targetId: tid }); } finally { raw.close(); }
      await sleep(700); const r2 = await reg(ctx, W1);
      clause(A, 'closing-the-popup-tab-by-cli-ref-uppercase-ref-and-raw-closeTarget-is-refused-and-it-stays', c1.code !== 0 && c2.code !== 0 && /browser_tab_not_owner/.test(c1.stderr + c2.stderr) && refusedMsg(rc?.error?.message) && !!blankTab(r2) && (await viewTargets(ctx)).length === vt0, `cli ${show(c1)} | upper ${show(c2)} | raw ${J(rc).slice(0, 140)} | registry ${brief(r2)}`);
    }
    // HA — the AGENT clicks the same link inside the HUMAN's tab
    {
      await hardReset(ctx);
      await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(PU)}).then(() => true)`);
      await waitFor(async () => /Popups fixture opener/.test((await reg(ctx, W1)).tabs[0]?.title ?? ''), 15000, 'the opener page in the human tab'); await sleep(500);
      const ab0 = (await abTabs(ctx, W1)).find((t) => /Popups fixture opener/.test(t.title)); await cli(ctx, W1, ['tab', ab0?.tabId ?? 't1']);
      const sn = await cli(ctx, W1, ['snapshot', '-i']); const ref = refFor(sn.stdout);
      const ck = await cli(ctx, W1, ['click', `@${ref}`]); await softWait(async () => !!blankTab(await reg(ctx, W1)), 15000, 'the popup tab after the agent click'); const r = await reg(ctx, W1); const bt = blankTab(r);
      clause(A, 'an-agent-click-on-target=_blank-in-the-USERS-tab-opens-a-human-owned-tab', ck.code === 0 && !!bt && bt.openedBy === 'human', `click ${show(ck)}; registry ${brief(r)}`);
      const ab = (await abTabs(ctx, W1)).find((t) => /Popups fixture blank/.test(t.title));
      const c1 = await cli(ctx, W1, ['tab', 'close', ab?.tabId ?? 't9']); await sleep(500); const r2 = await reg(ctx, W1);
      clause(A, 'and-the-agent-cannot-close-it', c1.code !== 0 && /browser_tab_not_owner/.test(c1.stderr + c1.stdout) && !!blankTab(r2), `close → ${show(c1)}; registry ${brief(r2)}`);
    }
    // A — the same link in an AGENT-opened tab
    {
      await hardReset(ctx);
      await cli(ctx, W1, ['tab', 'new', PU]); await softWait(async () => !!titled(await reg(ctx, W1), /Popups fixture opener/), 15000, 'agent tab on the opener page'); await sleep(500);
      const sn = await cli(ctx, W1, ['snapshot', '-i']); const ref = refFor(sn.stdout);
      const ck = await cli(ctx, W1, ['click', `@${ref}`]); await softWait(async () => !!blankTab(await reg(ctx, W1)), 15000, 'the popup tab'); const r = await reg(ctx, W1); const bt = blankTab(r);
      clause(A, 'an-agent-click-on-target=_blank-in-the-AGENTS-tab-opens-an-agent-owned-tab', ck.code === 0 && !!bt && bt.openedBy === 'agent', `click ${show(ck)}; registry ${brief(r)}`);
      const ab = (await abTabs(ctx, W1)).find((t) => /Popups fixture blank/.test(t.title));
      const c1 = await cli(ctx, W1, ['tab', 'close', ab?.tabId ?? 't9']); await sleep(700); const r2 = await reg(ctx, W1);
      clause(A, 'and-the-agent-can-close-it', c1.code === 0 && !blankTab(r2), `close → ${show(c1)}; registry ${brief(r2)}`);
    }
  },

  // ── seat 3: the agent's REAL path to a renderer-killer — `orchestra browser open chrome://…` on the user's tab (and the raw Page.navigate), measured ──
  async kill2(ctx) {
    const { W1, URL: U } = ctx; const A = 'kill2';
    const live = async (url) => { try { const o = await oracle(ctx, url, 5000); try { return await Promise.race([o.eval('1+1'), new Promise((r) => setTimeout(() => r('NO ANSWER'), 4000))]); } finally { o.close(); } } catch (e) { return `ERR ${String(e.message).slice(0, 50)}`; } };
    for (const url of ['chrome://crash', 'chrome://kill', 'chrome://hang', 'about:blank']) {
      const st = await fresh(ctx); const humanId = st.human?.id;
      const sw = await cli(ctx, W1, ['tab', st.abB?.tabId ?? 't1']);
      const o = await cli(ctx, W1, ['open', url], { timeoutMs: 20000 });
      await sleep(2500);
      const pages = (await ctx.targets()).filter((x) => x.type === 'page').map((x) => `${x.url.slice(0, 48)}|${x.title.slice(0, 20)}`);
      const lv = url === 'about:blank' ? 'n/a' : await live(U.b);
      const ev = await cli(ctx, W1, ['eval', '1 + 1'], { timeoutMs: 9000 });
      const r = await reg(ctx, W1);
      console.log(`  INFO  [${A}] open ${url} on the user's tab: ${show(o)} · then eval(1+1) via the CLI ${show(ev)} · oracle on the old page ${J(lv)} · page targets ${J(pages)} · registry ${brief(r)}`);
      if (url !== 'about:blank') clause(A, `cli-open-${url}-on-the-users-tab-leaves-its-renderer-alive`, ev.code === 0 && /2/.test(ev.stdout), `open → ${show(o)}; eval(1+1) afterwards → ${show(ev)}; the user's tab is ${ev.code === 0 ? 'answering' : 'NOT answering (renderer dead/hung)'}`);
    }
  },

  // ── seat 3 (F4 delta, de0d6a13): navigating a tab the agent did NOT open to a browser-internal URL — every spelling and route I can reach ────────────
  async internal(ctx) {
    const { W1, URL: U } = ctx; const A = 'internal';
    const tabRef = (st) => st.abB?.tabId ?? 't1';
    const alive = async (st, ms = 7000) => { await cli(ctx, W1, ['tab', tabRef(st)], { timeoutMs: 8000 }); const ev = await cli(ctx, W1, ['eval', '1 + 1'], { timeoutMs: ms }); return { ok: ev.code === 0 && /2/.test(ev.stdout), ev }; };
    const first = (r) => (r.stderr || r.stdout).trim().split('\n')[0].slice(0, 130);
    // (A) the agent's real path: `tab <user's tab>` then `open <url>`
    for (const url of ['chrome://crash', 'chrome://kill', 'chrome://hang', 'chrome://shorthang', 'CHROME://CRASH', '  chrome://crash', 'chrome:\t//crash', 'chrome:/crash', 'about:crash', 'ABOUT:CRASH', 'view-source:chrome://crash', 'chrome-untrusted://crash', 'devtools://devtools/bundled/devtools_app.html']) {
      const st = await fresh(ctx); await cli(ctx, W1, ['tab', tabRef(st)]);
      const o = await cli(ctx, W1, ['open', url], { timeoutMs: 20000 }); await sleep(1200);
      const a = await alive(st);
      clause(A, `cli-open ${J(url)} on the user's tab: it survives`, a.ok, `open → ${show(o)}${/refus/i.test(o.stderr + o.stdout) ? ' [REFUSED by the gate]' : ' [not refused by the gate]'}; eval(1+1) → ${show(a.ev)}`);
    }
    // controls: a harmless internal-looking-but-plain URL and an agent-OPENED tab going to chrome://version (allowed by design)
    {
      const st = await fresh(ctx); await cli(ctx, W1, ['tab', tabRef(st)]); const o = await cli(ctx, W1, ['open', 'about:blank']); const a = await alive(st);
      clause(A, 'ctl/open-about:blank-on-the-users-tab-works-and-it-answers', o.code === 0 && a.ok, `${show(o)}; ${show(a.ev)}`);
      let okc = null; const tried = [];
      for (const u of ['chrome://gpu', 'chrome://accessibility', 'chrome://process-internals']) {
        const st2 = await fresh(ctx); await cli(ctx, W1, ['tab', st2.abA?.tabId ?? 't2']); const o2 = await cli(ctx, W1, ['open', u]); await sleep(1200);
        const gu = await cli(ctx, W1, ['get', 'url']); tried.push(`${u}: ${first(o2)} → ${gu.stdout.trim().slice(0, 40)}`); if (o2.code === 0 && gu.stdout.includes(u.replace('chrome://', ''))) { okc = u; break; }
      }
      clause(A, 'ctl/an-agent-OPENED-tab-navigates-to-an-internal-page-the-gate-allows-it', !!okc, `loaded ${okc ?? 'NONE'}; tried ${J(tried)}`);
    }
    // (B) raw Page.navigate on the user's root session, and on an iframe CHILD session
    for (const url of ['chrome://crash', 'CHROME://kill', 'about:crash', 'view-source:chrome://hang']) {
      const st = await fresh(ctx); const { raw } = await openRaw(ctx, W1); let rep;
      try { const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); rep = await raw.callOn(att.result?.sessionId, 'Page.navigate', { url }); } finally { raw.close(); }
      await sleep(1500); const a = await alive(st);
      clause(A, `raw root Page.navigate ${J(url)}: refused and the user's tab answers`, !!rep?.error && /refused/i.test(rep.error.message ?? '') && a.ok, `reply ${J(rep).slice(0, 170)}; ${show(a.ev)}`);
    }
    {
      const st = await fresh(ctx, true); const humanId = st.human?.id; const { raw } = await openRaw(ctx, W1); const evs = []; raw.onEvent((m) => evs.push(m)); const outs = [];
      try {
        await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(humanId ?? '')}).then(() => true)`);
        const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const rootSid = att.result?.sessionId;
        await raw.callOn(rootSid, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.frame)}).then(() => true)`);
        await softWait(async () => evs.some((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid), 15000, 'a child session'); await sleep(800);
        const kids = evs.filter((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid && m.params?.targetInfo?.type === 'iframe').map((m) => m.params?.sessionId);
        for (const sid of kids) outs.push(await raw.callOn(sid, 'Page.navigate', { url: 'chrome://crash' }));
        clause(A, 'ctl/an-iframe-child-session-exists', kids.length > 0, `${kids.length} iframe session(s)`);
      } finally { raw.close(); }
      await sleep(1500); const live = await (async () => { try { const o = await oracle(ctx, U.frame, 5000); try { return await Promise.race([o.eval('1+1'), new Promise((r) => setTimeout(() => r('NO ANSWER'), 4000))]); } finally { o.close(); } } catch (e) { return `ERR ${String(e.message).slice(0, 40)}`; } })();
      const gone = (rep) => /Session with given id not found/i.test(rep?.error?.message ?? '');
      clause(A, 'child (iframe) session Page.navigate chrome://crash: refused (or the session was gone) and the user\'s page answers', outs.length > 0 && outs.every((r) => (!!r?.error && /refused/i.test(r.error.message ?? '')) || gone(r)) && outs.some((r) => /refused/i.test(r?.error?.message ?? '')) && live === 2, `${outs.map((r) => J(r?.error?.message ?? r).slice(0, 70)).join(' | ')}; eval(1+1) → ${J(live)}`);
    }
    // (D) page-initiated and redirect routes to chrome://crash, the user's tab loaded on my page; none of them may wedge it
    const http = await import('node:http'); const srv = http.createServer((req, res) => { if (req.url.startsWith('/to-crash')) { res.writeHead(302, { location: 'chrome://crash' }); return res.end(); } res.writeHead(404); res.end(); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const P = srv.address().port;
    const pageUrl = `${ctx.FIX}/v3-internal.html`;
    const onPage = async () => { const st = await fresh(ctx); await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(st.human?.id ?? '')}).then(() => true)`); await sleep(300); await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(pageUrl)}).then(() => true)`); await waitFor(async () => /V3 internal nav/.test((await reg(ctx, W1)).tabs.find((t) => t.openedBy === 'human')?.title ?? ''), 15000, 'my page'); await sleep(400); const ab = (await abTabs(ctx, W1)).find((t) => /V3 internal nav/.test(t.title)); await cli(ctx, W1, ['tab', ab?.tabId ?? 't1']); return { ...st, abB: ab }; };
    const vectors = [
      ['page JS location.href = chrome://crash (agent eval)', async () => cli(ctx, W1, ['eval', "location.href = 'chrome://crash'; 'sent'"])],
      ['page JS window.open(chrome://crash)', async () => cli(ctx, W1, ['eval', "window.open('chrome://crash'); 'sent'"])],
      ['page JS iframe.src = chrome://crash', async () => cli(ctx, W1, ['eval', "(() => { const fr = document.createElement('iframe'); fr.src = 'chrome://crash'; document.body.appendChild(fr); return 'sent'; })()"])],
      ['form POST to chrome://crash', async () => cli(ctx, W1, ['eval', "document.getElementById('f').submit(); 'sent'"])],
      ['meta refresh to chrome://crash', async () => cli(ctx, W1, ['eval', "const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=chrome://crash'; document.head.appendChild(m); 'sent'"])],
      ['agent click on <a href=chrome://crash>', async () => { const sn = await cli(ctx, W1, ['snapshot', '-i']); const ref = (/link "link to chrome:\/\/crash"[^\n]*ref=(e\d+)/.exec(sn.stdout) || [])[1]; return cli(ctx, W1, ['click', `@${ref}`]); }],
      ['open javascript:location.href=chrome://crash', async () => cli(ctx, W1, ['open', "javascript:location.href='chrome://crash'"], { timeoutMs: 15000 })],
      ['open http 302 → chrome://crash', async () => cli(ctx, W1, ['open', `http://127.0.0.1:${P}/to-crash`], { timeoutMs: 15000 })],
      ['open data: page with a meta refresh to chrome://crash', async () => cli(ctx, W1, ['open', "data:text/html,<meta http-equiv=refresh content='0;url=chrome://crash'>"], { timeoutMs: 15000 })],
    ];
    for (const [nm, run] of vectors) {
      let st, o, a; try { st = await onPage(); o = await run(); await sleep(2500); a = await alive({ abB: { tabId: (await abTabs(ctx, W1)).find((t) => t.active)?.tabId ?? st.abB?.tabId } }); } catch (e) { clause(A, `${nm}: harness`, false, `${String(e.message).slice(0, 120)}; registry ${brief(await reg(ctx, W1))}; page targets ${J((await ctx.targets()).filter((x) => x.type === 'page' && !/dist\/index\.html/.test(x.url)).map((x) => x.url.slice(0, 50)))}`); continue; }
      const pages = (await ctx.targets()).filter((x) => x.type === 'page' && !/dist\/index\.html/.test(x.url)).map((x) => x.url.slice(0, 40));
      clause(A, `${nm}: the user's tab keeps answering`, a.ok, `${show(o)}; eval(1+1) → ${show(a.ev)}; page targets ${J(pages)}`);
    }
    srv.close();
    // (E) the agent creates a NEW target at chrome://crash (allowed by design): what does it do to the USER's tab and to the agent's session?
    for (const [nm, mk] of [['CLI tab new chrome://crash', async () => cli(ctx, W1, ['tab', 'new', 'chrome://crash'], { timeoutMs: 20000 })], ['raw Target.createTarget chrome://crash', async () => { const { raw } = await openRaw(ctx, W1); try { return await raw.call('Target.createTarget', { url: 'chrome://crash' }); } finally { raw.close(); } }]]) {
      const st = await fresh(ctx); const o0 = await mk(); const o = o0 && typeof o0.code === 'number' ? o0 : { code: o0?.error ? 1 : 0, stdout: J(o0), stderr: '' }; await sleep(2500); const userPage = await (async () => { try { const oo = await oracle(ctx, U.b, 4000); try { return await Promise.race([oo.eval('1+1'), new Promise((rr) => setTimeout(() => rr('NO ANSWER'), 3500))]); } finally { oo.close(); } } catch (e) { return `ERR ${String(e.message).slice(0, 40)}`; } })(); const a = await alive(st); const lst = await cli(ctx, W1, ['tab', 'list'], { timeoutMs: 15000 }); const r = await reg(ctx, W1);
      const appOk = await ctx.ui.eval('1+1').then((v) => v === 2, () => false);
      console.log(`  INFO  [${A}] ${nm}: the user's renderer, asked by a SECOND client on the app's debug port: ${J(userPage)} (the CLI path: eval ${a.ok ? 'answers' : 'does NOT answer'}, tab list rc ${lst.code})`);
      clause(A, `${nm}: the USER's renderer answers (second client) — the agent session may be wedged, say so`, userPage === 2 && appOk, `${show(o)}; user's tab ${show(a.ev)}; tab list ${show(lst).slice(0, 200)}; registry ${brief(r)}; app alive ${appOk}`);
    }
    // (C) history entries
    {
      const st = await fresh(ctx); const { raw } = await openRaw(ctx, W1); const out = {};
      try {
        const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId;
        const h0 = await raw.callOn(sid, 'Page.getNavigationHistory', {}); const cur = h0.result?.entries?.[h0.result.currentIndex];
        out.ctl = await raw.callOn(sid, 'Page.navigateToHistoryEntry', { entryId: cur?.id });       // control: a plain entry is allowed
        out.bogus = await raw.callOn(sid, 'Page.navigateToHistoryEntry', { entryId: 987654321 });  // an entry that does not exist
      } finally { raw.close(); }
      await sleep(800); const a = await alive(st);
      clause(A, 'ctl/navigateToHistoryEntry-to-a-plain-entry-is-allowed', !out.ctl?.error && a.ok, `reply ${J(out.ctl).slice(0, 120)}; ${show(a.ev)}`);
      console.log(`  INFO  [${A}] navigateToHistoryEntry with an entryId that does not exist: ${J(out.bogus).slice(0, 200)}`);
    }
    for (const INT of ['chrome://version', 'chrome://gpu']) {
      // the human visits an internal page, comes back; the agent tries to go FORWARD to that entry
      const st = await fresh(ctx); const humanId = st.human?.id; await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(humanId ?? '')}).then(() => true)`); await sleep(300);
      await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(INT)}).then(() => true)`); await sleep(1500);
      const r1 = await reg(ctx, W1);
      await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.b)}).then(() => true)`); await sleep(1200);
      const { raw } = await openRaw(ctx, W1); let rep, hist;
      try {
        const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId;
        hist = (await raw.callOn(sid, 'Page.getNavigationHistory', {})).result; const internal = hist?.entries?.find((e) => /^chrome:\/\/(version|gpu)/.test(e.url));
        if (internal) rep = await raw.callOn(sid, 'Page.navigateToHistoryEntry', { entryId: internal.id }); else rep = { note: 'the human could not visit chrome://version: no internal entry in the history' };
      } finally { raw.close(); }
      await sleep(1000); const a = await alive(st);
      const hasEntry = !!hist?.entries?.find((e) => /^chrome:\/\/(version|gpu)/.test(e.url));
      console.log(`  INFO  [${A}] history entries ${J((hist?.entries ?? []).map((e) => e.url.slice(0, 40)))}`);
      if (hasEntry) clause(A, `navigateToHistoryEntry to a ${INT} entry of the user\'s tab is refused`, !!rep?.error && /refused/i.test(rep.error.message ?? '') && a.ok, `reply ${J(rep).slice(0, 170)}; ${show(a.ev)}`);
      else console.log(`  INFO  [${A}] history-entry route NOT exercised: ${J(rep)} (registry after the human's navigation: ${brief(r1)})`);
    }
    clause(A, 'the-app-is-still-alive', await ctx.ui.eval('1+1').then((v) => v === 2, () => false), 'renderer eval(1+1)');
  },

  // ── seat 3: after the agent creates a chrome://crash target, does ITS OWN session recover (the user's renderer is fine)? ──
  async recover(ctx) {
    const { W1 } = ctx; const A = 'recover';
    const st = await fresh(ctx); const o = await cli(ctx, W1, ['tab', 'new', 'chrome://crash'], { timeoutMs: 20000 }); await sleep(1500);
    const r0 = await reg(ctx, W1); const crashed = r0.tabs.find((t) => t.openedBy === 'agent' && !/Tabs fixture A/.test(t.title));
    const probe = async () => (await cli(ctx, W1, ['tab', 'list'], { timeoutMs: 8000 })).code === 0;
    const t0 = Date.now(); let recoveredAt = null; for (let i = 0; i < 6 && recoveredAt === null; i++) { if (await probe()) recoveredAt = Date.now() - t0; else await sleep(4000); }
    console.log(`  INFO  [${A}] tab new chrome://crash → ${show(o)}; registry ${brief(r0)}; \`tab list\` recovered by itself within 50 s: ${recoveredAt === null ? 'NO' : recoveredAt + ' ms'}`);
    // the human closes the crashed agent tab (what the × does); does the agent session come back?
    await ctx.ui.eval(`window.orchestra.browserTabClose(${sel(W1.id)}, ${sel(crashed?.id ?? '')}).then(() => true)`); await sleep(2500);
    let after = null; for (let i = 0; i < 4 && after === null; i++) { if (await probe()) after = true; else await sleep(3000); }
    const ev = await cli(ctx, W1, ['eval', '1 + 1'], { timeoutMs: 8000 });
    clause(A, 'once-the-human-closes-the-crashed-tab-the-agent-session-answers-again', after === true && ev.code === 0, `tab list ${after ? 'ok' : 'STILL HUNG'}; eval ${show(ev)}; registry ${brief(await reg(ctx, W1))}`);
  },

};
