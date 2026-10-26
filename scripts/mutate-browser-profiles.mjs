// Must-FAIL proof for the profils navigateur unit/stub tests (#400, ledger #405). Mutates the source IN PLACE, one
// clause at a time; each mutant MUST redden at least one of the #400 test files, and every touched file is restored
// from a byte-exact backup and `cmp`-checked after each mutant (and on any exit path).
// Run: node scripts/mutate-browser-profiles.mjs   (RC 0 = every mutant killed, restore byte-exact)

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = [
  'src/shared/browser-profile.test.ts',
  'src/main/browser-profiles.test.ts',
  'src/main/browser-profiles-ipc.test.ts',
  'src/main/browser-panel-profiles.test.ts',
  'src/main/browser-profiles-wiring.test.ts',
  'src/shared/browser-cookie-promote.test.ts',
  'src/shared/cdp-proxy-core.test.ts',
  'src/shared/cdp-tab-diff.test.ts',
];
const PANEL = 'src/main/browser-panel.ts';
const SVC = 'src/main/browser-profiles.ts';
const IPC = 'src/main/browser-profiles-ipc.ts';
const PURE = 'src/shared/browser-profile.ts';
const CDPHOST = 'src/main/browser-cdp-host.ts';
const CORE = 'src/shared/cdp-proxy-core.ts';
const PROMO = 'src/shared/browser-cookie-promote.ts';
const DIFF = 'src/shared/cdp-tab-diff.ts';
const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'bprof-mut-'));
const backups = new Map();
const orig = new Map();
const load = (rel) => {
  if (!orig.has(rel)) {
    const b = path.join(tmp, rel.replaceAll('/', '__') + '.orig');
    copyFileSync(path.join(root, rel), b);
    backups.set(rel, b);
    orig.set(rel, readFileSync(path.join(root, rel), 'utf8'));
  }
  return orig.get(rel);
};

// [file, name, find (exactly once), replace]
const MUTANTS = [
  // --- browser-panel.ts: which partition, what a move does ---
  [PANEL, 'buildTab ignores the panel partition (always ephemeral)', '      partition: panel.partition,\n', '      partition: partitionFor(panel.wsId, undefined),\n'],
  [PANEL, 'ensurePanel ignores the profile resolver', 'const profileId = profileOf?.(wsId);', 'const profileId = undefined;'],
  [PANEL, 'ensurePanel does not record the profile on the panel', '    partition: partitionFor(wsId, profileId),\n    profileId,', '    partition: partitionFor(wsId, profileId),'],
  [PANEL, 'reprofilePanel leaves the old views alive', '    for (const t of oldTabs) {\n      try {\n        destroyTab(t);\n      } catch (e) {\n        log.warn(\'browser-panel: reprofilePanel could not close an old view\', e);\n      }\n    }\n    try {\n      if (wasAttached) attachActive(panel);\n    } catch (e) {', '    for (const t of [] as typeof oldTabs) void t;\n    try {\n      if (wasAttached) attachActive(panel);\n    } catch (e) {'],
  [PANEL, 'reprofilePanel mints new tab ids', 'buildTab(panel, { openedBy: sn.openedBy, id: sn.id })', 'buildTab(panel, { openedBy: sn.openedBy })'],
  [PANEL, 'reprofilePanel does not reload the tabs\' URLs', '        if (sn.url) {\n          restoreUrls.set(tab, sn.url);', '        if (false as boolean) {\n          restoreUrls.set(tab, sn.url);'],
  [PANEL, 'reprofilePanel loses the active tab', 'panel.activeId = oldActive;', 'panel.activeId = panel.tabs[0].id;'],
  [PANEL, 'reprofilePanel never re-composites the active view', '      if (wasAttached) attachActive(panel);\n    } catch (e) {\n      log.warn(\'browser-panel: reprofilePanel could not re-composite the panel\', e);', '      void wasAttached;\n    } catch (e) {\n      log.warn(\'browser-panel: reprofilePanel could not re-composite the panel\', e);'],
  [PANEL, 'reprofilePanel does not detach the old attached view first', '  if (attachedTab) detachTab(panel, attachedTab);\n  panel.rebuilding = true;', '  panel.rebuilding = true;'],
  [PANEL, 'reprofilePanel rebuilds even for the same identity', '  if (partition === panel.partition) return panel.state;\n', ''],
  [PANEL, 'reprofilePanel builds a panel that is not open', '  if (!panel) return getState(wsId);\n  const partition', '  if (!panel) { ensurePanel(wsId); return getState(wsId); }\n  const partition'],
  [PANEL, 'reprofilePanel keeps the old profileId in the state', '    panel.partition = partition;\n    panel.profileId = profileId;', '    panel.partition = partition;'],
  [PANEL, 'the panel state never says which profile it runs on', '    ...(panel.profileId !== undefined ? { profileId: panel.profileId } : {}),\n', ''],
  [PANEL, 'sign-in flushing also watches ephemeral sessions', 'if (panel.profileId !== undefined) persistSignIns(ses);', 'persistSignIns(ses);'],
  [PANEL, 'sign-in flushing adds a watcher per tab', '  if (signInSessions.has(ses)) return;\n', ''],
  [PANEL, 'flushProfileStorage also flushes ephemeral partitions', '    if (panel.profileId === undefined) continue;\n', ''],
  [PANEL, 'a failed rebuild leaves a half-built panel', '      const half = panel.tabs;\n      panel.tabs = oldTabs;\n      panel.partition = prev.partition;\n      panel.profileId = prev.profileId;\n', '      const half = panel.tabs;\n'],
  [PANEL, 'the closing views are not tracked', '  trackClose(wc);\n', ''],
  [PANEL, 'settleClosedViews never waits', '  const ok = await Promise.race([settled, timedOut]);', '  const ok = true as boolean; void settled; void timedOut;'],
  [PANEL, 'settleClosedViews can wait forever', '  const ok = await Promise.race([settled, timedOut]);', '  const ok = await settled;'],
  [PANEL, 'workspacesOnProfile lists every open panel', '.filter((p) => p.profileId === profileId).map((p) => p.wsId)', '.map((p) => p.wsId)'],
  [SVC, 'delete does not wait for the closed views', '        if (!(await deps.settleViews())) {', '        if (!(await Promise.resolve(true))) {'],
  [SVC, 'delete ignores open panels the record does not know', '        for (const wsId of deps.openPanelsOn(profileId)) {\n          await deps.clearEphemeral(wsId);\n          deps.reprofilePanel(wsId, undefined);\n        }\n', ''],
  ['src/main/browser-profiles-host.ts', 'the host never waits for the closed views', 'settleViews: () => settleClosedViews(3000),', 'settleViews: async () => {},'],
  ['src/main/browser-profiles-host.ts', 'a detach broadcasts a DELETED key (the renderer keeps the old id)', 'const updated = { ...ws, browserProfileId: profileId };\n      await store.upsertWorkspace(updated);', 'const updated: typeof ws = { ...ws };\n      if (profileId === undefined) delete updated.browserProfileId; else updated.browserProfileId = profileId;\n      await store.upsertWorkspace(updated);'],
  [PURE, 'a refused CDP method passes for a profile workspace', "  if (kind !== undefined) return { ok: false, message: kind === 'clear' ? REFUSAL_CLEAR : REFUSAL_READ };", "  void kind;"],
  [PURE, 'an ephemeral workspace is refused too', '  if (input.profileId === undefined) return { ok: true };\n  const kind', '  const kind'],
  [PURE, 'every CDP call is refused for a profile workspace', "  if (COOKIE_CDP_METHOD.test(input.method)) return { ok: false, message: REFUSAL_UNKNOWN };\n  return { ok: true };", "  return { ok: false, message: REFUSAL_UNKNOWN };"],
  [PURE, 'Storage.clearCookies is not refused', "  ['Storage.clearCookies', 'clear'],\n", ''],
  [PURE, 'clearDataForOrigin (cookies of one origin) is not refused', "  ['Storage.clearDataForOrigin', 'clear'],\n", ''],
  [PURE, 'clearDataForStorageKey is not refused', "  ['Storage.clearDataForStorageKey', 'clear'],\n", ''],
  [PURE, 'the partition-wide cookie READ getAllCookies is not refused', "  ['Network.getAllCookies', 'read'],\n", ''],
  [PURE, 'Storage.getCookies is not refused', "  ['Storage.getCookies', 'read'],\n", ''],
  [PANEL, 'panelProfileId reads the wrong thing', 'return panels.get(wsId)?.profileId;', 'return undefined;'],
  [PURE, 'another host\'s cookies are readable by a profile workspace', '    if (targets === null || targets.some((t) => !isPageSite(input.pageUrl, t))) return { ok: false, message: REFUSAL_SITE };', '    if (false as boolean) return { ok: false, message: REFUSAL_SITE };'],
  [PURE, 'a malformed site-scoped call passes', '    if (targets === null || targets.some((t) => !isPageSite(input.pageUrl, t))) return { ok: false, message: REFUSAL_SITE };', '    if (targets !== null && targets.some((t) => !isPageSite(input.pageUrl, t))) return { ok: false, message: REFUSAL_SITE };'],
  [PURE, 'the PARENT host counts as the page\'s site (url-form parent leniency)', "  return h !== '' && h === pageHost;", "  return h !== '' && (h === pageHost || pageHost.endsWith(`.${h}`));"],
  [PURE, 'a SIBLING subdomain counts as the page\'s site', "  return h !== '' && h === pageHost;", "  return h !== '' && (h === pageHost || h.split('.').slice(1).join('.') === pageHost.split('.').slice(1).join('.'));"],
  [PURE, 'a suffix without a dot boundary counts as the page\'s site', "  return h !== '' && h === pageHost;", "  return h !== '' && (h === pageHost || pageHost.endsWith(h));"],
  [PURE, 'getCookies without urls is judged on the page only (the frame tree is ignored)', "return frameUrls ? frameUrls.filter(isHttp) : null;", "return [];"],
  [PURE, 'getCookies with an unknown frame tree passes', "return frameUrls ? frameUrls.filter(isHttp) : null;", "return frameUrls ? frameUrls.filter(isHttp) : [];"],
  [PURE, 'frames that are not http(s) are judged as sites', "return frameUrls ? frameUrls.filter(isHttp) : null;", "return frameUrls ?? null;"],
  [PURE, 'an empty urls list is treated as an explicit (empty) judgement', "if (p.urls === undefined || (Array.isArray(p.urls) && p.urls.length === 0)) return", "if (p.urls === undefined) return"],
  [PURE, 'the default-deny regex is narrowed back to Network|Storage (Page.deleteCookie passes)', 'const COOKIE_CDP_METHOD = /^\\w+\\.\\w*[Cc]ookie/;', 'const COOKIE_CDP_METHOD = /^(?:Network|Storage)\\.\\w*[Cc]ookie/;'],
  [PURE, 'an unknown cookie-carrying method passes', "  if (COOKIE_CDP_METHOD.test(input.method)) return { ok: false, message: REFUSAL_UNKNOWN };", "  void COOKIE_CDP_METHOD;"],
  [PURE, 'Storage.setCookies is not site-scoped (so it falls to the unknown-method refusal for EVERY call, even the own site)', "'Network.setCookies', 'Storage.setCookies',\n]);", "'Network.setCookies',\n]);"],
  [PURE, 'the unknown-method refusal has an EMPTY message', "'refused: this workspace\\'s browser carries a profil navigateur — this cookie command is not available here. Use `cookies get` / `cookies set` on the page you are on.';", "'';"],
  [PURE, 'the at-rest warning is dropped', "export const PROFILE_AT_REST_WARNING =\n  'Cookies and sign-ins of a profile are stored UNENCRYPTED on disk on this build (readable by anything running as you). Create profiles only for accounts you accept that for.';", "export const PROFILE_AT_REST_WARNING = '';"],
  [PURE, 'getCookies urls are not looked at', "      return Array.isArray(p.urls) && p.urls.every((x) => typeof x === 'string') ? (p.urls as string[]) : null;", "      return [];"],
  [PURE, 'deleteCookies domain is not looked at', "    case 'Network.deleteCookies':\n    case 'Network.setCookie':\n      return both(p);", "    case 'Network.deleteCookies':\n    case 'Network.setCookie':\n      return one(p.url);"],
  [PURE, 'setCookies entries are not looked at', "        const t = both(c as Record<string, unknown>);\n        if (!t) return null;\n        out.push(...t);", "        void c;"],
  [PANEL, 'promotion is immediate and from the event snapshot (no debounce, no re-read)', "      if (!pending.has(key)) pending.set(key, setTimeout(() => promote(key, cookie), PROMOTE_DEBOUNCE_MS));", "      { const p = promoteSessionCookie(cookie, Date.now() / 1000); if (p) void ses.cookies.set(p); }"],
  [PANEL, 'a cookie rewritten at every request is promoted at every rewrite', "      if (!pending.has(key)) pending.set(key, setTimeout(() => promote(key, cookie), PROMOTE_DEBOUNCE_MS));", "      setTimeout(() => promote(key, cookie), PROMOTE_DEBOUNCE_MS);"],
  [PANEL, 'the live cookie is not re-read before promoting', "      .get({ name: cookie.name, domain: cookie.domain, path: cookie.path })", "      .get({ name: cookie.name, domain: cookie.domain, path: cookie.path }).then(() => [cookie])"],
  [PANEL, 'stopSignInPersistence leaves the listener attached', "    ses.cookies.removeListener('changed', onChanged);\n", ''],
  [PANEL, 'stopSignInPersistence leaves pending promotions armed', "    for (const t of pending.values()) clearTimeout(t);\n    pending.clear();", ''],
  [PANEL, 'a throw closing an old view rolls the committed move back', "      log.warn('browser-panel: reprofilePanel could not close an old view', e);", "      throw e;"],
  [SVC, 'a delete with views still closing wipes anyway', "          return refuse('storage', 'Some of the profile’s tabs are still closing. Wait a moment and delete it again.');", "          void 0;"],
  [SVC, 'sign-in persistence is not stopped before the wipe', '        deps.stopSignIns(profileId);\n', ''],
  [SVC, 'leaving a profile never clears the ephemeral session (old sign-ins resurface)', '        if (d.changed && d.profileId === undefined) await deps.clearEphemeral(wsId);\n', ''],
  [SVC, 'an ephemeral detach that changes nothing still clears the (possibly in-use) ephemeral session', '        if (d.changed && d.profileId === undefined) await deps.clearEphemeral(wsId);', '        if (d.profileId === undefined) await deps.clearEphemeral(wsId);'],
  [SVC, 'attaching a profile clears the ephemeral session (still on screen)', '        if (d.changed && d.profileId === undefined) await deps.clearEphemeral(wsId);', '        if (d.changed) await deps.clearEphemeral(wsId);'],
  [PANEL, 'a removal after the read does not cancel the write (F4B)', '        if (!alive || (changedSeq.get(key) ?? 0) > started) return;', '        if (!alive) return;'],
  [PANEL, 'stopSignInPersistence does not stop an in-flight promotion (F4A)', '        if (!alive || (changedSeq.get(key) ?? 0) > started) return;', '        if ((changedSeq.get(key) ?? 0) > started) return;'],
  [PANEL, 'a same-name sibling cookie is promoted instead of the event\'s (F4C)', "        const own = live.find((c) => c.name === cookie.name && c.domain === cookie.domain && (c.path ?? '/') === (cookie.path ?? '/'));", "        const own = live[0];"],
  [PANEL, 'tabFrameUrls reads the wrong thing (main frame only)', 'return main ? main.framesInSubtree.map((f) => f.url) : undefined;', 'return main ? [main.url] : undefined;'],
  [PURE, 'a clear refusal has an EMPTY message (the proxy would fail open)', "'refused: this workspace\\'s browser carries a profil navigateur shared with other workspaces and sites — clearing it would sign them all out. ' +", "'' +"],
  [PURE, 'a site-scope refusal has an EMPTY message (the proxy would refuse with a generic text, never explain)', "  'refused: this workspace\\'s browser carries a profil navigateur — cookies of a site other than the page you are on (an embedded frame included) are not yours to read or change from here. ' +\n  'Navigate to that site first, or ask the human.';", "  '';"],
  [CDPHOST, 'the host drops the non-empty fallback (an empty message would fail open)', " d.message || 'refused: the profil navigateur policy of this workspace forbids this command';", " d.message;"],
  [CORE, 'the policy hook is handed the FIRST tab', 'const tab = this.port.listTabs().find((t) => t.id === tabId);', 'const tab = this.port.listTabs()[0];'],
  [CORE, 'the policy hook is handed the ACTIVE tab', 'const tab = this.port.listTabs().find((t) => t.id === tabId);', 'const tab = this.port.listTabs().find((t) => t.active);'],
  [CORE, 'a tab gone from the registry is still judged (the Target closed branch deleted)', "      if (!tab) throw new CdpError('Target closed.', ERR_SERVER);\n      // STRICT verdict contract", "      // STRICT verdict contract"],
  // (no mutant for the `!removed` early-out: the LIVE re-read is the real guard and makes it equivalent — a removed cookie reads back as nothing)
  // --- session cookies are promoted in a profile (OPS ruling) ---
  [PROMO, 'a cookie that already has an expiry is promoted again (set → changed loop)', 'if (c.session !== true || c.expirationDate !== undefined) return null;', 'if (c.session !== true) return null;'],
  [PROMO, 'a persistent cookie is promoted too', 'if (c.session !== true || c.expirationDate !== undefined) return null;', 'if (c.expirationDate !== undefined) return null;'],
  [PROMO, 'a host-only cookie becomes a domain cookie', 'if (c.hostOnly === false && c.domain) out.domain = c.domain;', 'if (c.domain) out.domain = c.domain;'],
  [PROMO, 'a secure cookie is set on an http url', "url: `${secure ? 'https' : 'http'}://${host}${path}`,", 'url: `http://${host}${path}`,'],
  [PROMO, 'the promoted lifetime is not 30 days', 'export const PROMOTED_COOKIE_TTL_S = 30 * 24 * 3600;', 'export const PROMOTED_COOKIE_TTL_S = 24 * 3600;'],
  [PROMO, 'the url host keeps the cookie domain\'s leading dot', "const host = (c.domain ?? '').replace(/^\\./, '');", "const host = (c.domain ?? '');"],
  [PANEL, 'session cookies are never promoted', '        if (!p) return;\n        await ses.cookies.set(p);', '        void p;\n        return;\n        await ses.cookies.set(p);'],
  // --- a logout is not undone by the pending promotion (seat-1 MAJOR, OPS lot 9020) ---
  // (no mutant for the outer-only or inner-only removal gate of `reconcile`: they are the SAME monotonic condition, so removing one is equivalent; the pair is mutated together)
  [PANEL, 'no post-write compensation at all (the logout is undone)', "        reconcile(key, p, domain, path, started);\n        const t = setTimeout(() => {\n          settling.delete(t);\n          reconcile(key, p, domain, path, started);\n        }, RECONCILE_SETTLE_MS);\n        settling.add(t);\n", ''],
  [PANEL, 'no compensation right after the write (only the settle re-check)', "        reconcile(key, p, domain, path, started);\n        const t = setTimeout(() => {", "        const t = setTimeout(() => {"],
  [PANEL, 'no settle re-check (a removal delivered after the write\'s promise is missed)', "        const t = setTimeout(() => {\n          settling.delete(t);\n          reconcile(key, p, domain, path, started);\n        }, RECONCILE_SETTLE_MS);\n        settling.add(t);\n", ''],
  [PANEL, 'compensation judges removals against the sequence at CHECK time, not the read start', "        reconcile(key, p, domain, path, started);\n        const t = setTimeout(() => {\n          settling.delete(t);\n          reconcile(key, p, domain, path, started);", "        reconcile(key, p, domain, path, seq);\n        const t = setTimeout(() => {\n          settling.delete(t);\n          reconcile(key, p, domain, path, seq);"],
  [PANEL, 'compensation runs without any removal seen since the read started', "    if (!alive || (removedSeq.get(key) ?? 0) <= started) return;\n    void ses.cookies\n      .get({ name: written.name, domain, path })\n      .then((live) => {\n        if (!alive || (removedSeq.get(key) ?? 0) <= started) return undefined;", "    if (!alive) return;\n    void ses.cookies\n      .get({ name: written.name, domain, path })\n      .then((live) => {\n        if (!alive) return undefined;"],
  [PANEL, 'compensation removes whatever cookie is live (a re-login is deleted)', "        if (!mine) return undefined;", "        if (!live.length) return undefined;"],
  [PANEL, 'an overwrite (our own promotion replacing the cookie) counts as a logout', "    const genuineRemoval = removed && cause !== 'overwrite';", "    const genuineRemoval = removed;"],
  [PANEL, 'the echo of our own compensating remove is read as a logout', "    if (genuineRemoval && ownRemoval.has(key)) {", "    if (false as boolean) {"],
  [PANEL, 'our compensating remove is not marked as ours', "        ownRemoval.add(key);\n        return ses.cookies.remove(", "        return ses.cookies.remove("],
  [PANEL, 'the own-echo mark is never dropped (an echo that never comes swallows a later logout)', "            settling.delete(t);\n            ownRemoval.delete(key);\n          }, OWN_ECHO_MS);", "            settling.delete(t);\n          }, OWN_ECHO_MS);"],
  // --- an in-place rebuild is a REPLACED page, not a changed one (seat-2 MAJOR: the agent's CLI met a dead session for good) ---
  [DIFF, 'the view identity is ignored (a rebuild reads as a bare `changed`)', 'was.view !== undefined && now.view !== undefined && was.view !== now.view', 'false'],
  [DIFF, 'an unknown view counts as replaced', 'was.view !== undefined && now.view !== undefined && was.view !== now.view', 'was.view !== now.view'],
  [DIFF, 'a replacement is announced as destroyed + created of the SAME id', "events.push({ kind: 'replaced', tab: now.tab });", "events.push({ kind: 'destroyed', tab: was.tab }, { kind: 'created', tab: now.tab });"],
  [CORE, 'a replaced page keeps its target id (agent-browser drops the same-id create in one batch and opens a blank tab)', "return this.derive(g === 0 ? `tab:${tabId}` : `tab:${tabId}:g${g}`);", "return this.derive(`tab:${tabId}`);"],
  [CORE, 'a replacement does not detach the sessions on the old page', "    this.onDebuggerDetached(tab.id, 'target closed');\n    this.generation.set(", "    this.generation.set("],
  [CORE, 'a replacement detaches under the NEW target id', "    const oldTarget = this.targetIdFor(tab.id);\n    this.onDebuggerDetached(tab.id, 'target closed');\n    this.generation.set(tab.id, (this.generation.get(tab.id) ?? 0) + 1);", "    const oldTarget = this.targetIdFor(tab.id);\n    this.generation.set(tab.id, (this.generation.get(tab.id) ?? 0) + 1);\n    this.onDebuggerDetached(tab.id, 'target closed');"],
  [CORE, 'the old target is destroyed BEFORE the new one is created (an empty moment for the client)', "      this.emit(c, 'Target.targetCreated', { targetInfo: this.targetInfo(tab) });\n      this.emit(c, 'Target.targetDestroyed', { targetId: oldTarget });", "      this.emit(c, 'Target.targetDestroyed', { targetId: oldTarget });\n      this.emit(c, 'Target.targetCreated', { targetInfo: this.targetInfo(tab) });"],
  [CORE, 'a replacement is announced to clients that never asked for discovery', "      if (!c.discover) continue;\n      this.emit(c, 'Target.targetCreated', { targetInfo: this.targetInfo(tab) });", "      this.emit(c, 'Target.targetCreated', { targetInfo: this.targetInfo(tab) });"],
  [CORE, 'a replacement is never turned into events', "    if (e.kind === 'replaced') return this.onTabReplaced(e.tab);\n", ''],
  [CORE, 'an attach in flight across a replacement is registered on the dead page', "(this.generation.get(t.id) ?? 0) !== gen || this.tabs.get(t.id) !== st", "false"],
  [CORE, 'an attach in flight across a replacement keeps its hold', "      if (this.tabs.get(t.id) === st) this.releaseTab(t.id);\n", ''],
  ['src/main/browser-cdp-host.ts', 'the host reads no view identity (a rebuild is invisible to the diff)', "view: bp.tabContents(wsId, t.id)?.id", "view: undefined"],
  // --- a rebuild publishes only WHOLE tab lists (seat-1 MAJOR: a half-built list read as a tab closed and reopened under the same id) ---
  [PANEL, 'publish speaks during a rebuild (the half-built guard is gone)', "  if (panel.rebuilding) return panel.state;\n", ''],
  [PANEL, 'a rebuild never raises the half-built guard', "  panel.rebuilding = true;\n", ''],
  [PANEL, 'a failed rebuild keeps the half-built guard (released on the success path only — the pre-D1 shape)', "  } finally {\n    panel.rebuilding = false;\n  }\n  return publish(panel);", "  } catch (e) {\n    throw e;\n  }\n  panel.rebuilding = false;\n  return publish(panel);"],
  [PANEL, 'the rollback steps abort each other (a half-built view that will not close loses the original error)', "        try {\n          destroyTab(t);\n        } catch (err) {\n          log.warn('browser-panel: reprofilePanel rollback could not close a half-built view', err);\n        }", "        destroyTab(t);"],
  [PANEL, 'a finished rebuild keeps the half-built guard (its own publish is swallowed)', "  } finally {\n    panel.rebuilding = false;\n  }\n  return publish(panel);", "  } finally {\n  }\n  return publish(panel);"],
  // --- browser-profiles.ts: the orchestration ---
  [SVC, 'delete never clears the partition storage', '          await deps.clearStorage(profileId);', '          void profileId;'],
  [SVC, 'delete forgets the profile even when the clear failed', "          return refuse('storage', `Could not clear", "          void refuse('storage', `Could not clear"],
  [SVC, 'delete does not reload the carriers ephemeral', '          await deps.clearEphemeral(wsId);\n          deps.reprofilePanel(wsId, undefined);\n        }\n        //    …and so is any OPEN panel', '          await deps.clearEphemeral(wsId);\n        }\n        //    …and so is any OPEN panel'],
  [SVC, 'delete does not clear the carriers\' record', '          await deps.setWorkspaceProfile(wsId, undefined);', ''],
  [SVC, 'delete forgets the profile before the carriers move', 'const d = decideDelete({ profiles, workspaces: deps.workspaces(), profileId: id as BrowserProfileId });\n        if (!d.ok) return refuse(d.reason, d.message);', 'const d = decideDelete({ profiles, workspaces: deps.workspaces(), profileId: id as BrowserProfileId });\n        if (!d.ok) return refuse(d.reason, d.message);\n        await deps.setProfiles(profiles.filter((p) => p.id !== id));'],
  [SVC, 'attach does not record the profile on the workspace', '        if (prev !== d.profileId) await deps.setWorkspaceProfile(wsId, d.profileId);', ''],
  [SVC, 'attach leaves the record when the panel could not move', '          if (prev !== d.profileId) await deps.setWorkspaceProfile(wsId, prev).catch(() => {});', ''],
  [SVC, 'operations are not serialized', 'const run = chain.then(fn, fn);', 'const run = fn();'],
  [SVC, 'create may reuse a taken id', '        while (profiles.some((p) => p.id === id)) id = deps.mintId();\n', ''],
  [SVC, 'rename ignores the name check', 'const c = checkProfileName(name, profiles, cur.id);\n        if (!c.ok) return refuse(c.reason, c.message);', 'const c = { ok: true as const, name: String(name) };'],
  // --- browser-profiles-ipc.ts: who may ask ---
  [IPC, 'create is not sender-checked', "guard('browserProfiles:create', e) ?? run(", 'run('],
  [IPC, 'rename is not sender-checked', "guard('browserProfiles:rename', e) ?? run(", 'run('],
  [IPC, 'delete is not sender-checked', "guard('browserProfiles:delete', e) ?? run(", 'run('],
  [IPC, 'attach is not sender-checked', "guard('browser:profileAttach', e) ?? run(", 'run('],
  [IPC, 'the guard accepts a sub-frame / unknown frame', 'const fromMainFrame = e.senderFrame != null && e.senderFrame === e.sender?.mainFrame;', 'const fromMainFrame = true;'],
  [IPC, 'a frameless sender is admitted (undefined === undefined)', 'const fromMainFrame = e.senderFrame != null && e.senderFrame === e.sender?.mainFrame;', 'const fromMainFrame = e.senderFrame === e.sender?.mainFrame;'],
  [IPC, 'a refusal is not logged', "    log.warn(`browser-profiles: ${channel} refused — sender ${e.sender?.id ?? '?'} is not the app window`);\n", ''],
  [IPC, 'an unexpected failure rejects the invoke', "    try {\n      return await fn();\n    } catch (e) {\n      log.error(`browser-profiles: ${channel} failed`, e);\n      return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e), profiles: service.list() };\n    }", '    return await fn();'],
  // --- shared/browser-profile.ts: the rules ---
  [PURE, 'the caller check accepts unknown ids (undefined === undefined)', "typeof c.senderId === 'number' && typeof c.mainId === 'number' && ", ''],
  [PURE, 'the caller check ignores which window sent it', 'c.senderId === c.mainId && c.senderIsMainFrame', 'c.senderIsMainFrame'],
  [PURE, 'the caller check ignores sub-frames', 'c.senderId === c.mainId && c.senderIsMainFrame', 'c.senderId === c.mainId'],
  [PURE, 'a profile partition is not persist:', '`persist:orchestra-profile-${profileId}`', '`orchestra-profile-${profileId}`'],
  [PURE, 'partitionFor swaps the identities', 'profileId === undefined ? ephemeralPartition(wsId) : profilePartition(profileId)', 'profileId === undefined ? profilePartition(profileId as never) : ephemeralPartition(wsId)'],
  [PURE, 'the ephemeral partition is shared by all workspaces', '`orchestra-browser-${wsId}`', '`orchestra-browser`'],
  [PURE, 'a dangling profile id still counts as attached', 'return recorded !== undefined && profiles.some((p) => p.id === recorded) ? recorded : undefined;', 'return recorded;'],
  [PURE, 'delete detaches every workspace', '.filter((w) => w.browserProfileId === input.profileId)', ''],
  [PURE, 'a rename clashes with its own name', 'p.id !== selfId && p.name.toLowerCase() === key', 'p.name.toLowerCase() === key'],
  [PURE, 'name uniqueness is case-sensitive', 'p.name.toLowerCase() === key', 'p.name === name'],
  [PURE, 'attach always reports a change', 'changed: now !== input.target }', 'changed: true }'],
  [PURE, 'attach accepts a profile that does not exist', "if (!input.profiles.some((p) => p.id === input.target)) {", 'if (false as boolean) {'],
  [PURE, 'a malformed id reaches a partition name', 'if (!isBrowserProfileId(id) || seen.has(id)) continue;', 'if (seen.has(id as string)) continue;'],
  [PURE, 'a repeated id is kept twice', 'if (!isBrowserProfileId(id) || seen.has(id)) continue;', 'if (!isBrowserProfileId(id)) continue;'],
  // --- wiring: an agent surface reaching a profile operation, the generic table serving a write, no module-scope init ---
  ['src/main/agent-browser-tools.ts', 'an MCP browser tool can re-profile a panel', "import * as bp from './browser-panel';", "import * as bp from './browser-panel';\nvoid bp.reprofilePanel;"],
  ['src/main/hooks-server.ts', 'a socket route can attach a profile', "const maxBytes = route === '/spawn' || route === '/message' ? 1_048_576 : 4096;", "const maxBytes = route === '/spawn' || route === '/message' || route === '/profileAttach' ? 1_048_576 : 4096;"],
  ['src/main/api-handlers.ts', 'the generic table serves a profile write', "  browserTabClose: 'browser:tabClose',", "  browserTabClose: 'browser:tabClose',\n  browserProfileAttach: 'browser:profileAttach',"],
  ['src/main/index.ts', 'the human wiring is never installed', 'initBrowserProfiles(() => mainWindow?.webContents.id ?? null);', ''],
  ['src/renderer/components/BrowserSettings.tsx', 'Settings can attach a profile', "setError(r.ok ? null : r.message);\n    return r.ok;", "setError(r.ok ? null : r.message);\n    void window.orchestra.browserProfileAttach('x', null);\n    return r.ok;"],
];

const run = () => spawnSync('node', ['--test', '--experimental-strip-types', ...TESTS], { cwd: root, encoding: 'utf8' });
function restoreAll() {
  for (const [rel, b] of backups) copyFileSync(b, path.join(root, rel));
  for (const [rel, b] of backups) {
    if (!readFileSync(path.join(root, rel)).equals(readFileSync(b))) throw new Error(`RESTORE FAILED: ${rel}`);
  }
}
process.on('exit', () => { for (const [rel, b] of backups) { try { copyFileSync(b, path.join(root, rel)); } catch {} } });

for (const m of MUTANTS) load(m[0]);
if (process.argv.includes('--check')) { // every mutant string LIVE (exactly one occurrence), nothing run
  let bad = 0;
  for (const [file, name, find] of MUTANTS) { const n = orig.get(file).split(find).length - 1; if (n !== 1) bad++; if (n !== 1) console.log(`DEAD ${name} (${n}x in ${file})`); }
  console.log(`${MUTANTS.length - bad}/${MUTANTS.length} live`);
  process.exit(bad ? 1 : 0);
}
const base = run();
if (base.status !== 0) { console.log('BASELINE FAILS — abort\n' + base.stdout.slice(-3000)); process.exit(2); }
const baseTests = /# tests (\d+)/.exec(base.stdout)?.[1];
console.log(`baseline PASS (${baseTests} tests, ${/# skipped (\d+)/.exec(base.stdout)?.[1]} skipped)`);

let killed = 0;
const survivors = [];
for (const [file, name, find, replace] of MUTANTS) {
  if (process.env.MUT_ONLY && !name.includes(process.env.MUT_ONLY)) continue;
  const src = orig.get(file);
  const n = src.split(find).length - 1;
  if (n !== 1) { console.log(`ABORT: mutant "${name}" find-string occurs ${n}x in ${file} (need exactly 1)`); restoreAll(); process.exit(2); }
  const next = src.replace(find, replace);
  if (next === src) { console.log(`ABORT: mutant "${name}" did not change ${file}`); restoreAll(); process.exit(2); }
  writeFileSync(path.join(root, file), next);
  const r = run();
  restoreAll();
  const failing = (r.stdout.match(/^not ok .*/gm) || []).length;
  const dead = r.status !== 0;
  if (dead) killed++; else survivors.push(name);
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} [${path.basename(file)}] ${name}${dead ? `  (${failing} arm(s) red)` : ''}`);
}
const same = [...backups].every(([rel, b]) => readFileSync(path.join(root, rel)).equals(readFileSync(b)));
console.log(`\n${killed}/${MUTANTS.length} killed; restore byte-exact: ${same}`);
if (survivors.length) console.log('SURVIVORS:\n  ' + survivors.join('\n  '));
process.exit(survivors.length || !same ? 1 : 0);
