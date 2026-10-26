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
    clause(A, 'a-real-click-on-a-human-tab-x-under-the-notice-closes-that-tab-only', before.tabs.length === 3 && after.tabs.length === 2 && !after.tabs.some((t) => t.id === second.id) && after.tabs.some((t) => t.openedBy === 'agent') && after.tabs.some((t) => t.openedBy === 'human'), `before ${brief(before)} → after ${brief(after)}`);
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
};
