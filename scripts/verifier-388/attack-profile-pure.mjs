// Verifier adversarial table for #400 (seat 1, node half): decideAgentCdp / isPageSite / cdpSiteTargets, isHumanProfileCaller + the IPC guard with forged event shapes,
// profile names/ids/attach/delete. PURE: no electron, no fs writes, no network. usage: node --experimental-strip-types attack-profile-pure.mjs <repo-root>
// exp: REFUSE (policy must refuse) | ALLOW (must be allowed — control or by design) | GAP (policy ALLOWS although a stricter reading refuses: declared finding, passes when allowed)
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] ?? '.');
const P = await import(pathToFileURL(path.join(root, 'src/shared/browser-profile.ts')).href);
const IPC = await import(pathToFileURL(path.join(root, 'src/main/browser-profiles-ipc.ts')).href);
const PID = 'bp-0123456789ab', PID2 = 'bp-ba9876543210';
let bad = 0, gaps = 0, ok = 0;
const row = (id, exp, got, label, extra = '') => {
  const v = exp === 'GAP' ? (got === 'ALLOW' ? 'GAP' : 'OK') : exp === got ? 'OK' : 'BYPASS';
  if (v === 'OK') ok++; else if (v === 'GAP') gaps++; else bad++;
  console.log(`${id.padEnd(5)} ${v.padEnd(7)} exp=${exp.padEnd(6)} got=${got.padEnd(6)} ${label}${extra ? ` | ${extra}` : ''}`);
};
const PAGE = 'https://app.example.com/dash';
const dec = (method, params, o = {}) => { const r = P.decideAgentCdp({ method, params, profileId: 'profileId' in o ? o.profileId : PID, pageUrl: 'page' in o ? o.page : PAGE, frameUrls: 'frames' in o ? o.frames : [o.page ?? PAGE] }); if (!r.ok && (typeof r.message !== 'string' || r.message === '')) throw new Error('EMPTY REFUSAL MESSAGE for ' + method); return r.ok ? 'ALLOW' : 'REFUSE'; };
const t = (id, exp, label, method, params, o) => { let got; try { got = dec(method, params, o); } catch (e) { got = 'THROW'; } row(id, exp, got, label, JSON.stringify(params ?? null).slice(0, 90)); };

// ── A. method names ──
for (const [i, m] of ['Network.clearBrowserCookies', 'Storage.clearCookies', 'Storage.clearDataForOrigin', 'Storage.clearDataForStorageKey', 'Network.getAllCookies', 'Storage.getCookies'].entries()) t(`A${i + 1}`, 'REFUSE', `by name: ${m} (any params)`, m, { origin: 'https://app.example.com', storageTypes: 'cookies' });
t('A7', 'ALLOW', 'CONTROL: ephemeral workspace (profileId undefined) is never refused', 'Network.clearBrowserCookies', {}, { profileId: undefined });
t('A8', 'ALLOW', 'CONTROL: unrelated method', 'Page.navigate', { url: 'https://evil.example/' });
t('A9', 'REFUSE', 'lower-case domain "network.getAllCookies": the default-deny regex is domain-agnostic (stricter than Chromium needs)', 'network.getAllCookies', {});
t('A10', 'REFUSE', 'trailing space in the name: the cookie regex has no end anchor, so it is refused (stricter than Chromium needs)', 'Network.getAllCookies ', {});
for (const [i, m] of ['Network.setCookieControls', 'Network.deleteCookie', 'Storage.getCookiesFoo', 'Network.cookieX', 'Storage.setCookie', 'Network.getCookiePartitionKey', 'Network.clearCookies'].entries()) t(`A${11 + i}`, 'REFUSE', `unknown cookie-carrying method refused by default: ${m}`, m, {});
t('A18', 'GAP', 'Page.getCookies / Page.deleteCookie (domain Page is outside the Network|Storage regex; REMOVED from Chromium 130? — inert only if so)', 'Page.getCookies', {});
t('A19', 'GAP', 'Storage-domain method addressing ANY origin/bucket without the word cookie: Storage.deleteStorageBucket', 'Storage.deleteStorageBucket', { storageKey: 'https://other.com/', bucketName: 'x' });
t('A20', 'GAP', 'Storage.getSharedStorageEntries(ownerOrigin = another site)', 'Storage.getSharedStorageEntries', { ownerOrigin: 'https://other.com' });
t('A21', 'GAP', 'Storage.clearSharedStorageEntries(ownerOrigin = another site)', 'Storage.clearSharedStorageEntries', { ownerOrigin: 'https://other.com' });
t('A22', 'GAP', 'Storage.runBounceTrackingMitigations (deletes tracker-site state of the whole partition)', 'Storage.runBounceTrackingMitigations', {});
t('A23', 'GAP', 'Storage.clearTrustTokens(issuerOrigin)', 'Storage.clearTrustTokens', { issuerOrigin: 'https://other.com' });
t('A24', 'GAP', 'Storage.getUsageAndQuota(origin = another site) — information only', 'Storage.getUsageAndQuota', { origin: 'https://other.com' });
t('A25', 'GAP', 'Network.loadNetworkResource(url=other site, includeCredentials) — fetches with the shared jar (same capability as navigating there; declared by design)', 'Network.loadNetworkResource', { url: 'https://other.com/inbox', options: { disableCache: true, includeCredentials: true } });

// ── B. site scope: Network.getCookies ──
const gc = (urls, o) => dec('Network.getCookies', urls === undefined ? {} : { urls }, o);
const tg = (id, exp, label, urls, o) => { let got; try { got = gc(urls, o); } catch { got = 'THROW'; } row(id, exp, got, label, JSON.stringify(urls ?? null).slice(0, 90)); };
tg('B1', 'ALLOW', 'CONTROL: the page URL itself', [PAGE]);
tg('B2', 'ALLOW', 'same host, other path / port / scheme', ['http://app.example.com:8080/x?y#z']);
tg('B3', 'ALLOW', 'UPPER-CASE host', ['HTTPS://APP.EXAMPLE.COM/']);
tg('B4', 'ALLOW', 'scheme-less urls absent + frame tree = page only', undefined);
tg('B5', 'REFUSE', 'urls absent but a CROSS-SITE iframe in the frame tree', undefined, { frames: [PAGE, 'https://ads.other.com/f'] });
tg('B6', 'REFUSE', 'urls absent and frame tree unknown (undefined) ⇒ fail closed', undefined, { frames: undefined });
tg('B7', 'REFUSE', 'urls [] and frame tree unknown', [], { frames: undefined });
tg('B8', 'ALLOW', 'urls [] with frame tree = page only (CDP semantics = page + subframes)', [], {});
tg('B9', 'REFUSE', 'parent domain', ['https://example.com/']);
tg('B10', 'REFUSE', 'sibling subdomain', ['https://other.example.com/']);
tg('B11', 'REFUSE', 'child subdomain', ['https://x.app.example.com/']);
tg('B12', 'REFUSE', 'public suffix com', ['https://com/']);
tg('B13', 'REFUSE', 'public suffix co.uk (page a.co.uk)', ['https://co.uk/'], { page: 'https://a.co.uk/' });
tg('B14', 'REFUSE', 'public suffix github.io (page me.github.io) — other tenant', ['https://other.github.io/'], { page: 'https://me.github.io/' });
tg('B15', 'REFUSE', 'github.io itself', ['https://github.io/'], { page: 'https://me.github.io/' });
tg('B16', 'REFUSE', 'localhost vs 127.0.0.1', ['http://127.0.0.1:3000/'], { page: 'http://localhost:3000/' });
tg('B17', 'REFUSE', '127.0.0.1 vs localhost', ['http://localhost:3000/'], { page: 'http://127.0.0.1:3000/' });
tg('B18', 'ALLOW', 'IPv6 literal, same', ['http://[::1]:3000/'], { page: 'http://[::1]:3000/' });
tg('B19', 'ALLOW', 'decimal IP normalises to the same host', ['http://2130706433/'], { page: 'http://127.0.0.1/' });
tg('B20', 'REFUSE', 'userinfo trick: page host in the userinfo', ['https://app.example.com@evil.com/']);
tg('B21', 'REFUSE', 'page host in the query', ['https://evil.com/?https://app.example.com/']);
tg('B22', 'REFUSE', 'page host in the fragment', ['https://evil.com/#@app.example.com']);
tg('B23', 'REFUSE', 'page host as a prefix label', ['https://app.example.com.evil.com/']);
tg('B24', 'REFUSE', 'backslash userinfo variant', ['https://evil.com\\@app.example.com/']);
tg('B25', 'ALLOW', 'newline inside the host is stripped by the URL parser (same host)', ['https://app.exam\nple.com/']);
tg('B26', 'ALLOW', 'fullwidth dots map to the same host in URL form (GURL does the same)', ['https://app．example．com/']);
tg('B27', 'REFUSE', 'trailing-dot FQDN (different string) ⇒ fail closed', ['https://app.example.com./']);
tg('B28', 'REFUSE', 'punycode page vs unicode URL of ANOTHER host', ['https://пример2.рф/'], { page: 'https://xn--e1afmkfd.xn--p1ai/' });
tg('B29', 'ALLOW', 'punycode page vs the SAME host written in unicode (URL form)', ['https://пример.рф/'], { page: 'https://xn--e1afmkfd.xn--p1ai/' });
tg('B30', 'REFUSE', 'urls is a STRING not an array', 'https://app.example.com/');
tg('B31', 'REFUSE', 'urls holds a non-string', [PAGE, 123]);
tg('B32', 'REFUSE', 'urls holds an empty string', ['']);
tg('B33', 'REFUSE', 'one good + one foreign url', [PAGE, 'https://other.com/']);
tg('B34', 'REFUSE', 'urls is an object', { 0: PAGE, length: 1 });
tg('B35', 'REFUSE', 'blank tab (about:blank) owns no site', [PAGE], { page: 'about:blank', frames: ['about:blank'] });
tg('B36', 'REFUSE', 'page undefined', [PAGE], { page: undefined });
tg('B37', 'REFUSE', 'file: page has no host', ['file:///etc/hostname'], { page: 'file:///etc/hostname' });
tg('B38', 'REFUSE', 'data: page', ['data:text/html,x'], { page: 'data:text/html,x' });
tg('B39', 'REFUSE', 'blob: page (opaque host)', ['blob:https://app.example.com/uuid'], { page: 'blob:https://app.example.com/uuid' });
tg('B40', 'ALLOW', 'javascript://page-host/ (same host string, a non-web scheme: inert in CDP)', ['javascript://app.example.com/%0aalert(1)']);
tg('B41', 'REFUSE', 'bare host string in urls (no scheme) — not a URL: judged as a domain, must equal page host', ['example.com']);
tg('B42', 'ALLOW', 'bare host equal to page host in urls (no scheme)', ['app.example.com']);

// ── C. setCookie / setCookies / deleteCookies ──
const tc = (id, exp, label, method, params, o) => t(id, exp, label, method, params, o);
tc('C1', 'ALLOW', 'CONTROL: setCookie url=page', 'Network.setCookie', { name: 'a', value: 'b', url: PAGE });
tc('C2', 'ALLOW', 'setCookie domain=page host', 'Network.setCookie', { name: 'a', value: 'b', domain: 'app.example.com' });
tc('C3', 'ALLOW', 'setCookie domain=.page host (leading dot)', 'Network.setCookie', { name: 'a', value: 'b', domain: '.app.example.com' });
tc('C4', 'REFUSE', 'setCookie domain=parent', 'Network.setCookie', { name: 'a', value: 'b', domain: 'example.com' });
tc('C5', 'REFUSE', 'setCookie domain=.parent', 'Network.setCookie', { name: 'a', value: 'b', domain: '.example.com' });
tc('C6', 'REFUSE', 'setCookie url=page + domain=other (both are judged)', 'Network.setCookie', { name: 'a', value: 'b', url: PAGE, domain: 'other.com' });
tc('C7', 'REFUSE', 'setCookie url=other + domain=page', 'Network.setCookie', { name: 'a', value: 'b', url: 'https://other.com/', domain: 'app.example.com' });
tc('C8', 'REFUSE', 'setCookie domain is an array', 'Network.setCookie', { name: 'a', value: 'b', domain: ['app.example.com'] });
tc('C9', 'REFUSE', 'setCookie domain is a number', 'Network.setCookie', { name: 'a', value: 'b', domain: 5 });
tc('C10', 'ALLOW', 'setCookie with neither url nor domain (Chromium errors / uses the page URL): no foreign site named', 'Network.setCookie', { name: 'a', value: 'b' });
tc('C11', 'ALLOW', 'setCookie with a partitionKey of another top-level site but the page\'s own url', 'Network.setCookie', { name: 'a', value: 'b', url: PAGE, partitionKey: { topLevelSite: 'https://victim.com', hasCrossSiteAncestor: false } });
tc('C12', 'REFUSE', 'setCookies: second cookie foreign', 'Network.setCookies', { cookies: [{ name: 'a', value: 'b', url: PAGE }, { name: 'c', value: 'd', domain: 'other.com' }] });
tc('C13', 'ALLOW', 'setCookies: all own', 'Network.setCookies', { cookies: [{ name: 'a', value: 'b', url: PAGE }, { name: 'c', value: 'd', domain: '.app.example.com' }] });
tc('C14', 'REFUSE', 'setCookies: cookies not an array', 'Network.setCookies', { cookies: { 0: { name: 'a', url: PAGE } } });
tc('C15', 'REFUSE', 'setCookies: a null entry', 'Network.setCookies', { cookies: [null] });
tc('C16', 'REFUSE', 'setCookies: missing cookies', 'Network.setCookies', {});
tc('C17', 'REFUSE', 'Storage.setCookies other domain', 'Storage.setCookies', { cookies: [{ name: 'a', value: 'b', domain: 'other.com' }] });
tc('C18', 'REFUSE', 'Storage.setCookies browserContextId + foreign', 'Storage.setCookies', { browserContextId: 'X', cookies: [{ name: 'a', value: 'b', url: 'https://other.com/' }] });
tc('C19', 'REFUSE', 'deleteCookies domain=parent', 'Network.deleteCookies', { name: 'sid', domain: 'example.com' });
tc('C20', 'ALLOW', 'deleteCookies domain=page', 'Network.deleteCookies', { name: 'sid', domain: 'app.example.com' });
tc('C21', 'REFUSE', 'deleteCookies url=other', 'Network.deleteCookies', { name: 'sid', url: 'https://other.com/' });
tc('C22', 'ALLOW', 'deleteCookies by name only (Chromium needs url|domain → error; no foreign site named)', 'Network.deleteCookies', { name: 'sid' });
tc('C23', 'REFUSE', 'params is undefined for setCookies', 'Network.setCookies', undefined);
tc('C24', 'REFUSE', 'params is a string for getCookies... (urls missing → frame-tree path with frames=[page] ⇒ allowed is wrong?)', 'Network.setCookies', 'x');
t('C25', 'ALLOW', 'getCookies params = array (treated as {} → frame tree = page only; Chromium rejects the shape)', 'Network.getCookies', [], {});
{ const r = P.decideAgentCdp({ method: 'Network.getCookies', params: { urls: [PAGE] }, profileId: 'not-a-profile-id', pageUrl: PAGE }); row('C26', 'ALLOW', r.ok ? 'ALLOW' : 'REFUSE', 'any defined profileId string enables the policy (id shape is not checked here): own page allowed'); }
{ const r = P.decideAgentCdp({ method: 'Network.getAllCookies', params: {}, profileId: '', pageUrl: PAGE }); row('C27', 'REFUSE', r.ok ? 'ALLOW' : 'REFUSE', 'profileId "" (falsy but defined) must still refuse — `=== undefined` compare, not truthiness'); }
{ const r = P.decideAgentCdp({ method: 'Network.getAllCookies', params: {}, profileId: null, pageUrl: PAGE }); row('C28', 'REFUSE', r.ok ? 'ALLOW' : 'REFUSE', 'profileId null (NOT undefined): the policy stays ON (fail closed on a null from a store read)'); }
// every refusal carries a non-empty message (the proxy core fails closed on '' anyway)
{ let empty = 0, n = 0; for (const m of ['Network.clearBrowserCookies', 'Network.getAllCookies', 'Storage.getCookies', 'Network.setCookieControls']) { n++; const r = P.decideAgentCdp({ method: m, params: {}, profileId: PID, pageUrl: PAGE }); if (r.ok || !r.message) empty++; } row('C29', 'REFUSE', empty === 0 ? 'REFUSE' : 'ALLOW', `every refusal has a non-empty message (${n} sampled)`); }

// ── D. isHumanProfileCaller + the IPC guard with forged event shapes ──
const hc = (id, exp, label, c) => row(id, exp, P.isHumanProfileCaller(c) ? 'ALLOW' : 'REFUSE', label, JSON.stringify(c));
hc('D1', 'ALLOW', 'CONTROL: main window, top frame', { senderId: 7, mainId: 7, senderIsMainFrame: true });
hc('D2', 'REFUSE', 'other webContents id', { senderId: 8, mainId: 7, senderIsMainFrame: true });
hc('D3', 'REFUSE', 'sub-frame of the main window', { senderId: 7, mainId: 7, senderIsMainFrame: false });
hc('D4', 'REFUSE', 'no main window (mainId null)', { senderId: 7, mainId: null, senderIsMainFrame: true });
hc('D5', 'REFUSE', 'sender id undefined', { senderId: undefined, mainId: 7, senderIsMainFrame: true });
hc('D6', 'REFUSE', 'both undefined', { senderId: undefined, mainId: undefined, senderIsMainFrame: true });
hc('D7', 'REFUSE', 'both null', { senderId: null, mainId: null, senderIsMainFrame: true });
hc('D8', 'REFUSE', 'NaN === NaN', { senderId: NaN, mainId: NaN, senderIsMainFrame: true });
hc('D9', 'REFUSE', 'string ids "7" vs 7', { senderId: '7', mainId: 7, senderIsMainFrame: true });
hc('D10', 'REFUSE', 'string ids "7" vs "7"', { senderId: '7', mainId: '7', senderIsMainFrame: true });
hc('D11', 'REFUSE', 'boxed numbers', { senderId: Object(7), mainId: Object(7), senderIsMainFrame: true });
hc('D12', 'REFUSE', 'missing senderIsMainFrame', { senderId: 7, mainId: 7 });
const mkIpc = () => { const handlers = new Map(); const calls = []; const svc = new Proxy({}, { get: (_, k) => k === 'list' ? () => [] : (...a) => { calls.push([String(k), a]); return Promise.resolve({ ok: true, profiles: [] }); } }); return { handlers, calls, svc, ipc: { handle: (c, fn) => handlers.set(c, fn) } }; };
const mainFrame = { name: 'main' }; const subFrame = { name: 'sub' };
const evs = [
  ['E1', 'ALLOW', 'CONTROL: main window top frame', { sender: { id: 7, mainFrame }, senderFrame: mainFrame }, 7],
  ['E2', 'REFUSE', 'senderFrame undefined', { sender: { id: 7, mainFrame } }, 7],
  ['E3', 'REFUSE', 'senderFrame null AND sender.mainFrame null (null === null must not pass)', { sender: { id: 7, mainFrame: null }, senderFrame: null }, 7],
  ['E4', 'REFUSE', 'senderFrame undefined AND sender.mainFrame undefined', { sender: { id: 7 }, senderFrame: undefined }, 7],
  ['E5', 'REFUSE', 'sub-frame of the main window', { sender: { id: 7, mainFrame }, senderFrame: subFrame }, 7],
  ['E6', 'REFUSE', 'a panel tab (other id) whose senderFrame IS its own mainFrame', { sender: { id: 9, mainFrame: subFrame }, senderFrame: subFrame }, 7],
  ['E7', 'REFUSE', 'main window id is null (window gone)', { sender: { id: 7, mainFrame }, senderFrame: mainFrame }, null],
  ['E8', 'REFUSE', 'sender undefined', { senderFrame: mainFrame }, 7],
  ['E9', 'REFUSE', 'event is an empty object', {}, 7],
  ['E10', 'REFUSE', 'senderFrame is a different but equal-looking object', { sender: { id: 7, mainFrame }, senderFrame: { name: 'main' } }, 7],
  ['E11', 'REFUSE', 'forged id spoofed via a string "7"', { sender: { id: '7', mainFrame }, senderFrame: mainFrame }, 7],
];
for (const [id, exp, label, ev, mainId] of evs) {
  for (const [channel, args] of [['browserProfiles:create', ['X']], ['browserProfiles:rename', [PID, 'Y']], ['browserProfiles:delete', [PID]], ['browser:profileAttach', ['ws-1', PID]]]) {
    const { handlers, calls, svc, ipc } = mkIpc();
    IPC.registerBrowserProfilesIpc({ ipc, getMainWebContentsId: () => mainId, service: svc, log: { warn() {}, error() {} } });
    let res, threw = false; try { res = await handlers.get(channel)(ev, ...args); } catch { threw = true; }
    const wrote = calls.some(([k]) => ['create', 'rename', 'remove', 'assign'].includes(k));
    const got = threw ? 'REFUSE' : res && res.ok === false && res.reason === 'not-human' && !wrote ? 'REFUSE' : wrote ? 'ALLOW' : 'REFUSE';
    row(`${id}${channel.slice(-3)}`, exp, got, `${label} → ${channel}`, `wrote=${wrote} threw=${threw} reason=${res?.reason ?? '-'}`);
  }
}
// the read channel is deliberately open (names only): record, do not judge
{ const { handlers, svc, ipc } = mkIpc(); IPC.registerBrowserProfilesIpc({ ipc, getMainWebContentsId: () => 7, service: svc, log: { warn() {}, error() {} } }); const r = handlers.get('browserProfiles:list')({ sender: { id: 99 } }); row('D20', 'GAP', Array.isArray(r) ? 'ALLOW' : 'REFUSE', 'INFO: browserProfiles:list answers ANY sender (profile names only)'); }
// the channels are not served anywhere else (generic API table, CLI verbs, socket routes): grep with a positive control
{
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const files = ['src/main/api-handlers.ts', 'src/main/hooks-server.ts', 'src/cli/index.ts'].filter((f) => read(f));
  const hit = (needle) => files.filter((f) => read(f).includes(needle));
  row('D21', 'ALLOW', hit('workspaces:promote').length > 0 ? 'ALLOW' : 'REFUSE', 'POSITIVE CONTROL: the grep surface contains a known served channel (workspaces:promote)', files.join(','));
  for (const needle of ['browserProfiles:', 'browser:profileAttach', 'profileAttach']) row(`D22${needle.length}`, 'REFUSE', hit(needle).length === 0 ? 'REFUSE' : 'ALLOW', `no API-table / hooks route / CLI mention of "${needle}"`, hit(needle).join(','));
  { const a = read('src/main/api-handlers.ts'); const tail = a.slice(a.indexOf('export const METHOD_IPC_CHANNELS')); row('D2299', 'REFUSE', /browserProfile/.test(tail) ? 'ALLOW' : 'REFUSE', 'METHOD_IPC_CHANNELS / served table has NO browserProfile entry (the only api-handlers mention is the Omit<> exclusion)'); row('D2298', 'ALLOW', /Omit<[^]*browserProfileAttach/.test(a) || /\| 'browserProfileAttach'/.test(a) ? 'ALLOW' : 'REFUSE', 'CONTROL: the exclusion list does name the write methods'); }
}

// ── E. names / ids / attach / delete ──
const prof = [{ id: PID, name: 'Work', createdAt: 1 }, { id: PID2, name: 'Home', createdAt: 2 }];
const nm = (id, exp, label, raw, self) => { const r = P.checkProfileName(raw, prof, self); row(id, exp, r.ok ? 'ALLOW' : 'REFUSE', label, JSON.stringify(raw).slice(0, 60)); };
nm('E20', 'ALLOW', 'CONTROL: a fresh name', 'Staging');
nm('E21', 'REFUSE', 'duplicate, other case', 'wORk');
nm('E22', 'ALLOW', 'rename to its own name in another case', 'WORK', PID);
nm('E23', 'REFUSE', 'empty / whitespace only', '   \t\n ');
nm('E24', 'REFUSE', 'non-string (number)', 5);
nm('E25', 'REFUSE', 'non-string (object with toString)', { toString: () => 'Evil' });
nm('E26', 'REFUSE', '41 characters', 'x'.repeat(41));
nm('E27', 'ALLOW', '40 characters', 'x'.repeat(40));
nm('E28', 'REFUSE', 'control chars collapse to a duplicate ("Wo\\u0000rk" → "Wo rk" no; "Work\\u0000" → "Work")', 'Work\u0000');
nm('E29', 'GAP', 'zero-width space makes "Wo​rk" distinct from "Work" (look-alike name; UI only)', 'Wo​rk');
nm('E30', 'GAP', 'right-to-left override in a name (bidi spoof; C1/bidi controls are not stripped)', 'Home‮');
nm('E31', 'GAP', 'Cyrillic homoglyph "Ηome" vs "Home"', 'Ηome');
{ const r = P.normalizeBrowserProfiles([{ id: 'bp-0123456789ab', name: 'ok' }, { id: 'bp-0123456789ab', name: 'dup' }, { id: '../../etc', name: 'x' }, { id: 'bp-0123456789AB', name: 'upper' }, { id: 'bp-0123456789abc', name: 'long' }, null, 5, { id: 'bp-aaaaaaaaaaaa', name: '' }, { id: 'bp-bbbbbbbbbbbb', name: 'x'.repeat(41) }]); row('E32', 'ALLOW', r.length === 1 && r[0].name === 'ok' ? 'ALLOW' : 'REFUSE', 'normalizeBrowserProfiles keeps only the one valid minted id (dups, traversal, upper-case, long, empty, over-long dropped)', JSON.stringify(r.map((x) => x.id))); }
{ let threw = 0; for (const v of ['bp-0123456789ab/../x', 'persist:x', '', undefined, 'bp-0123456789ab\n', 'BP-0123456789ab']) { try { P.profilePartition(v); } catch { threw++; } } row('E33', 'REFUSE', threw === 6 ? 'REFUSE' : 'ALLOW', 'profilePartition throws on every non-minted id (newline suffix included)', `threw ${threw}/6`); }
{ const a = P.decideAttach({ profiles: prof, current: PID, target: 'bp-ffffffffffff' }); row('E34', 'REFUSE', a.ok ? 'ALLOW' : 'REFUSE', 'attach to an unknown profile refused'); const b = P.decideAttach({ profiles: prof, current: 'bp-ffffffffffff', target: null }); row('E35', 'ALLOW', b.ok && b.changed === false ? 'ALLOW' : 'REFUSE', 'detach from a DANGLING recorded id is a no-op (changed=false: nothing to rebuild)'); }
{ const d = P.decideDelete({ profiles: prof, workspaces: [{ id: 'w1', browserProfileId: PID }, { id: 'w2' }, { id: 'w3', browserProfileId: 'bp-ffffffffffff' }, { id: 'w4', browserProfileId: PID }], profileId: PID }); row('E36', 'ALLOW', d.ok && JSON.stringify(d.detach) === '["w1","w4"]' ? 'ALLOW' : 'REFUSE', 'delete detaches EVERY workspace recording the profile (also ones not open), no others', JSON.stringify(d.detach)); }
console.log(`SUMMARY: ok=${ok} declared-gaps=${gaps} bypass=${bad}`);
process.exit(bad ? 1 : 0);
