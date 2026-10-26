import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_PROFILE_NAME_MAX,
  checkProfileName,
  cdpSiteTargets,
  decideAgentCdp,
  isPageSite,
  decideAttach,
  decideDelete,
  effectiveProfileId,
  ephemeralPartition,
  isBrowserProfileId,
  isHumanProfileCaller,
  normalizeBrowserProfiles,
  PROFILE_REFUSED_CDP_METHODS,
  partitionFor,
  PROFILE_AT_REST_WARNING,
  profilePartition,
} from './browser-profile.ts';
import type { BrowserProfile } from './types.ts';

const A = 'bp-aaaaaaaaaaaa';
const B = 'bp-bbbbbbbbbbbb';
const profiles: BrowserProfile[] = [
  { id: A, name: 'Staging', createdAt: 1 },
  { id: B, name: 'Prod admin', createdAt: 2 },
];

test('isBrowserProfileId: only the minted shape', () => {
  assert.equal(isBrowserProfileId(A), true);
  for (const bad of ['', 'bp-', 'bp-AAAAAAAAAAAA', 'bp-aaaaaaaaaaa', 'bp-aaaaaaaaaaaaa', 'x-aaaaaaaaaaaa', 'bp-aaaaaaaaaaaa/../x', undefined, 7, null]) {
    assert.equal(isBrowserProfileId(bad), false, String(bad));
  }
});

test('normalizeBrowserProfiles: drops malformed + repeated ids, trims names, keeps order', () => {
  const out = normalizeBrowserProfiles([
    { id: A, name: '  Staging  ', createdAt: 5 },
    { id: A, name: 'Dup id', createdAt: 6 },
    { id: 'persist:evil', name: 'Bad id' },
    { id: B, name: '' },
    { id: 'bp-cccccccccccc', name: 'x'.repeat(BROWSER_PROFILE_NAME_MAX + 1) },
    { id: 'bp-dddddddddddd', name: 'No date' },
    null,
    'str',
  ]);
  assert.deepEqual(out, [
    { id: A, name: 'Staging', createdAt: 5 },
    { id: 'bp-dddddddddddd', name: 'No date', createdAt: 0 },
  ]);
  assert.deepEqual(normalizeBrowserProfiles(undefined), []);
  assert.deepEqual(normalizeBrowserProfiles({ 0: 'x' }), []);
});

test('checkProfileName: empty / too long / duplicate (case-insensitive, others only) / ok', () => {
  assert.deepEqual(checkProfileName('  New   one ', profiles), { ok: true, name: 'New one' });
  assert.equal(checkProfileName('   ', profiles).ok, false);
  assert.equal((checkProfileName('', profiles) as { reason: string }).reason, 'empty');
  assert.equal((checkProfileName(undefined, profiles) as { reason: string }).reason, 'empty');
  assert.equal((checkProfileName('x'.repeat(BROWSER_PROFILE_NAME_MAX + 1), profiles) as { reason: string }).reason, 'too-long');
  assert.equal(checkProfileName('x'.repeat(BROWSER_PROFILE_NAME_MAX), profiles).ok, true);
  assert.equal((checkProfileName('staging', profiles) as { reason: string }).reason, 'duplicate');
  // renaming a profile to its own name / another casing of it is fine; to ANOTHER profile's name is not
  assert.equal(checkProfileName('STAGING', profiles, A).ok, true);
  assert.equal((checkProfileName('prod admin', profiles, A) as { reason: string }).reason, 'duplicate');
  // control characters cannot smuggle a second line into a label
  assert.deepEqual(checkProfileName('a\nb\u0000c', profiles), { ok: true, name: 'a b c' });
});

test('partitions: ephemeral has NO persist: prefix, a profile ALWAYS has; the id is never free text', () => {
  assert.equal(ephemeralPartition('ws1'), 'orchestra-browser-ws1');
  assert.equal(profilePartition(A), 'persist:orchestra-profile-bp-aaaaaaaaaaaa');
  assert.equal(partitionFor('ws1', undefined), 'orchestra-browser-ws1');
  assert.equal(partitionFor('ws1', A), 'persist:orchestra-profile-bp-aaaaaaaaaaaa');
  assert.equal(partitionFor('ws1', A), partitionFor('ws2', A), 'two workspaces share a profile partition');
  assert.notEqual(partitionFor('ws1', undefined), partitionFor('ws2', undefined), 'ephemeral stays per workspace');
  assert.throws(() => profilePartition('persist:../../x'), /not a browser profile id/);
  assert.throws(() => partitionFor('ws1', 'whatever'), /not a browser profile id/);
});

test('effectiveProfileId: a dangling id reads as ephemeral, a live one stays', () => {
  assert.equal(effectiveProfileId(A, profiles), A);
  assert.equal(effectiveProfileId('bp-eeeeeeeeeeee', profiles), undefined);
  assert.equal(effectiveProfileId(undefined, profiles), undefined);
  assert.equal(effectiveProfileId(A, []), undefined);
});

test('decideAttach: attach, switch, same (no-op), detach, unknown', () => {
  assert.deepEqual(decideAttach({ profiles, current: undefined, target: A }), { ok: true, profileId: A, changed: true });
  assert.deepEqual(decideAttach({ profiles, current: A, target: B }), { ok: true, profileId: B, changed: true });
  assert.deepEqual(decideAttach({ profiles, current: A, target: A }), { ok: true, profileId: A, changed: false });
  assert.deepEqual(decideAttach({ profiles, current: A, target: null }), { ok: true, profileId: undefined, changed: true });
  assert.deepEqual(decideAttach({ profiles, current: undefined, target: null }), { ok: true, profileId: undefined, changed: false });
  // a recorded-but-deleted profile is already ephemeral: detaching it changes nothing to rebuild
  assert.deepEqual(decideAttach({ profiles, current: 'bp-eeeeeeeeeeee', target: null }), { ok: true, profileId: undefined, changed: false });
  const r = decideAttach({ profiles, current: undefined, target: 'bp-eeeeeeeeeeee' });
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'unknown-profile');
});

test('decideDelete: lists exactly the workspaces carrying the profile; unknown is refused', () => {
  const workspaces = [
    { id: 'w1', browserProfileId: A },
    { id: 'w2' },
    { id: 'w3', browserProfileId: B },
    { id: 'w4', browserProfileId: A },
  ];
  assert.deepEqual(decideDelete({ profiles, workspaces, profileId: A }), { ok: true, detach: ['w1', 'w4'] });
  assert.deepEqual(decideDelete({ profiles, workspaces, profileId: B }), { ok: true, detach: ['w3'] });
  assert.deepEqual(decideDelete({ profiles, workspaces: [], profileId: A }), { ok: true, detach: [] });
  assert.equal(decideDelete({ profiles, workspaces, profileId: 'bp-eeeeeeeeeeee' }).ok, false);
});

test('isHumanProfileCaller: only the main window top frame; fail closed on anything unknown', () => {
  assert.equal(isHumanProfileCaller({ senderId: 3, mainId: 3, senderIsMainFrame: true }), true);
  assert.equal(isHumanProfileCaller({ senderId: 7, mainId: 3, senderIsMainFrame: true }), false, 'a panel/other window');
  assert.equal(isHumanProfileCaller({ senderId: 3, mainId: 3, senderIsMainFrame: false }), false, 'a sub-frame of the main window');
  assert.equal(isHumanProfileCaller({ senderId: 3, mainId: null, senderIsMainFrame: true }), false, 'no main window known');
  assert.equal(isHumanProfileCaller({ senderId: undefined, mainId: undefined, senderIsMainFrame: true }), false, 'undefined === undefined must not pass');
  assert.equal(isHumanProfileCaller({ senderId: null, mainId: null, senderIsMainFrame: true }), false);
});

test('PROFILE_AT_REST_WARNING: always shown at creation, says the cookies are UNENCRYPTED on disk (the Electron cookie-encryption fuse is off in the shipped build), independent of any keyring state', () => {
  assert.match(PROFILE_AT_REST_WARNING, /UNENCRYPTED on disk/);
  assert.ok(PROFILE_AT_REST_WARNING.length > 40);
});

const PAGE = 'https://app.example.com/dashboard';
const FRAMES = [PAGE]; // a page with no other frames
// `null` = an ephemeral workspace (a default parameter would swallow an `undefined`)
const cdp = (method: string, params: unknown, o: { pageUrl?: string; profile?: string | null; frames?: readonly string[] } = {}) =>
  decideAgentCdp({ method, params, profileId: o.profile === null ? undefined : (o.profile ?? A), pageUrl: 'pageUrl' in o ? o.pageUrl : PAGE, frameUrls: o.frames ?? FRAMES });
const refused = (r: ReturnType<typeof cdp>): string => (r.ok ? '' : r.message);

test('decideAgentCdp: partition-wide / origin-wide clears and partition-wide cookie reads are refused for a profile workspace, never for an ephemeral one', () => {
  assert.deepEqual([...PROFILE_REFUSED_CDP_METHODS.keys()].sort(), [
    'Network.clearBrowserCookies', 'Network.getAllCookies', 'Storage.clearCookies', 'Storage.clearDataForOrigin', 'Storage.clearDataForStorageKey', 'Storage.getCookies',
  ]);
  for (const [method, kind] of PROFILE_REFUSED_CDP_METHODS) {
    assert.match(refused(cdp(method, {})), kind === 'clear' ? /sign them all out/ : /expose sign-ins beyond this page/, method);
    assert.deepEqual(cdp(method, {}, { profile: null }), { ok: true }, `${method} on an ephemeral workspace`);
  }
  for (const method of ['Runtime.evaluate', 'Page.navigate', 'Storage.getStorageKeyForFrame', 'Network.enable', 'DOM.getDocument']) {
    assert.deepEqual(cdp(method, {}), { ok: true }, `${method} is not a cookie method`);
  }
});

test('isPageSite: the page\'s own HOST only — a url or a cookie domain; never a parent domain, a sibling, a public suffix, a bare TLD, another site or a blank page', () => {
  assert.equal(isPageSite(PAGE, 'https://app.example.com/x'), true);
  assert.equal(isPageSite(PAGE, 'app.example.com'), true, 'a domain cookie on the page\'s own host');
  assert.equal(isPageSite(PAGE, '.app.example.com'), true, 'with the leading dot');
  assert.equal(isPageSite(PAGE, 'HTTPS://APP.EXAMPLE.COM/'), true, 'case-insensitive');
  assert.equal(isPageSite('http://localhost:3000/', 'http://localhost:9/'), true, 'ports do not make a site');
  assert.equal(isPageSite('http://127.0.0.1:1/', 'http://127.0.0.1:2/'), true);
  // the review (F2a): the PARENT host's host-only HttpOnly cookies are not the page's — url-form and domain-form alike
  for (const t of ['https://example.com/', 'example.com', '.example.com', 'https://staging.example.com/', 'https://admin.example.com/', 'https://other.org/', 'com', 'co.uk', 'github.io', 'https://evilexample.com/', 'https://sub.app.example.com/']) {
    assert.equal(isPageSite(PAGE, t), false, t);
  }
  assert.equal(isPageSite('https://admin.staging.example.com/', 'https://staging.example.com/'), false, 'a deeper page may not read its parent either');
  assert.equal(isPageSite('https://app.example.co.uk/', 'co.uk'), false, 'a public suffix');
  assert.equal(isPageSite('about:blank', 'https://example.com/'), false, 'a page with no host owns no site');
  assert.equal(isPageSite(undefined, 'https://example.com/'), false);
  assert.equal(isPageSite(PAGE, ''), false);
  assert.equal(isPageSite(PAGE, 'http://[bad'), false, 'an unparsable target');
});

test('cdpSiteTargets: what each site-scoped method names; getCookies WITHOUT urls = the frame tree; malformed = null', () => {
  const frames = ['https://app.example.com/', 'https://idp.other.org/login', 'about:blank', 'data:text/html,x', 'http://127.0.0.1:5/'];
  assert.deepEqual(cdpSiteTargets('Network.getCookies', {}, frames), ['https://app.example.com/', 'https://idp.other.org/login', 'http://127.0.0.1:5/'], 'only http(s) frames can carry cookies');
  assert.deepEqual(cdpSiteTargets('Network.getCookies', { urls: [] }, frames), ['https://app.example.com/', 'https://idp.other.org/login', 'http://127.0.0.1:5/'], 'an empty list means "omitted" too');
  assert.equal(cdpSiteTargets('Network.getCookies', {}), null, 'no frame tree known and none named: cannot be judged — refuse');
  assert.equal(cdpSiteTargets('Network.getCookies', undefined), null);
  assert.deepEqual(cdpSiteTargets('Network.getCookies', { urls: ['https://a.com/', 'https://b.com/'] }, frames), ['https://a.com/', 'https://b.com/'], 'explicit urls ignore the frames');
  assert.equal(cdpSiteTargets('Network.getCookies', { urls: 'https://a.com/' }), null);
  assert.equal(cdpSiteTargets('Network.getCookies', { urls: [1] }), null);
  assert.deepEqual(cdpSiteTargets('Network.deleteCookies', { name: 'x', url: 'https://a.com/', domain: 'b.com' }), ['https://a.com/', 'b.com']);
  assert.deepEqual(cdpSiteTargets('Network.setCookie', { name: 'x', value: 'y' }), []);
  assert.equal(cdpSiteTargets('Network.setCookie', { url: 5 }), null);
  for (const m of ['Network.setCookies', 'Storage.setCookies']) {
    assert.deepEqual(cdpSiteTargets(m, { cookies: [{ name: 'a', url: 'https://a.com/' }, { name: 'b', domain: 'c.com' }] }), ['https://a.com/', 'c.com'], m);
    assert.equal(cdpSiteTargets(m, { cookies: 'nope' }), null, m);
    assert.equal(cdpSiteTargets(m, { cookies: [null] }), null, m);
  }
  assert.deepEqual(cdpSiteTargets('Runtime.evaluate', { expression: 'x' }), []);
});

test('decideAgentCdp (site scope): another host\'s cookies — url, domain, parent, an embedded frame — are refused on every site-scoped method; the page\'s own host passes; ephemeral never refused', () => {
  const other = 'https://prod-admin.other.org/';
  const parent = 'https://example.com/';
  for (const [method, params] of [
    ['Network.getCookies', { urls: [other] }], ['Network.getCookies', { urls: [PAGE, other] }], ['Network.getCookies', { urls: [parent] }],
    ['Network.deleteCookies', { name: 'sid', url: other }], ['Network.deleteCookies', { name: 'sid', domain: '.other.org' }],
    ['Network.deleteCookies', { name: 'sid', url: parent }], ['Network.deleteCookies', { name: 'sid', domain: 'example.com' }],
    ['Network.setCookie', { name: 'sid', value: 'x', url: other }], ['Network.setCookie', { name: 'sid', value: 'x', url: parent }],
    ['Network.setCookies', { cookies: [{ name: 'a', url: PAGE }, { name: 'b', url: other }] }],
    ['Storage.setCookies', { cookies: [{ name: 'a', domain: 'other.com' }] }],
    ['Network.getCookies', { urls: 'not-an-array' }],
  ] as Array<[string, unknown]>) {
    assert.match(refused(cdp(method, params)), /site other than the page you are on/, `${method} ${JSON.stringify(params)}`);
    assert.deepEqual(cdp(method, params, { profile: null }), { ok: true }, `ephemeral: ${method}`);
  }
  // review F2b: `cookies get` WITHOUT urls reads the page AND its subframes
  assert.match(refused(cdp('Network.getCookies', {}, { frames: [PAGE, 'https://idp.other.org/sso'] })), /an embedded frame included/, 'a cross-site SSO iframe');
  assert.match(refused(cdp('Network.getCookies', {}, { frames: [PAGE, 'https://admin.example.com/'] })), /an embedded frame included/, 'a sibling-subdomain iframe');
  assert.match(refused(decideAgentCdp({ method: 'Network.getCookies', params: {}, profileId: A, pageUrl: PAGE })), /an embedded frame included/, 'frame tree unknown: refuse');
  for (const [method, params, frames] of [
    ['Network.getCookies', {}, [PAGE]], ['Network.getCookies', {}, [PAGE, 'https://app.example.com/frame', 'about:blank']],
    ['Network.getCookies', { urls: [PAGE] }, [PAGE]], ['Network.getCookies', { urls: [] }, [PAGE]],
    ['Network.deleteCookies', { name: 'sid', url: PAGE }, [PAGE]], ['Network.deleteCookies', { name: 'sid', domain: '.app.example.com' }, [PAGE]],
    ['Network.setCookie', { name: 'a', value: 'b' }, [PAGE]], ['Network.setCookie', { name: 'a', value: 'b', url: PAGE }, [PAGE]],
    ['Network.setCookies', { cookies: [{ name: 'a', url: PAGE }] }, [PAGE]], ['Storage.setCookies', { cookies: [{ name: 'a', domain: 'app.example.com' }] }, [PAGE]],
  ] as Array<[string, unknown, string[]]>) {
    assert.deepEqual(cdp(method, params, { frames }), { ok: true }, `${method} ${JSON.stringify(params)}`);
  }
  assert.equal(cdp('Network.getCookies', { urls: [PAGE] }, { pageUrl: 'about:blank' }).ok, false, 'a blank tab owns no site');
  assert.deepEqual(cdp('Runtime.evaluate', { expression: 'document.cookie' }), { ok: true }, 'in-page JS is the page\'s own business');
});

test('decideAgentCdp (F3): ANY other cookie-carrying Network/Storage method is refused by default for a profile workspace — an unknown one cannot bypass the site scope', () => {
  for (const m of ['Network.setCookieControls', 'Storage.trackCookieBucketsChanges', 'Network.someFutureCookieThing', 'Storage.deleteCookiesForSite']) {
    assert.match(refused(cdp(m, {})), /cookie command is not available here/, m);
    assert.deepEqual(cdp(m, {}, { profile: null }), { ok: true }, `${m} on an ephemeral workspace`);
  }
  assert.deepEqual(cdp('Network.getRequestPostData', {}), { ok: true }, 'a method that does not carry cookies');
  // review R1: ANY protocol domain — `Page.deleteCookie{cookieName,url}` (deprecated, still in the protocol) deletes another host's cookie by url
  for (const m of ['Page.deleteCookie', 'Page.getCookies', 'Emulation.setCookie', 'Audits.someCookieMethod']) {
    assert.match(refused(cdp(m, { cookieName: 'sid', url: 'https://example.com/' })), /cookie command is not available here/, m);
    assert.deepEqual(cdp(m, {}, { profile: null }), { ok: true }, `${m} on an ephemeral workspace`);
  }
  assert.deepEqual(cdp('Page.navigate', { url: 'https://example.com/' }), { ok: true }, 'a non-cookie method of the same domain stays allowed');
});

test('decideAgentCdp: EVERY refusal carries a NON-EMPTY string message (the proxy core judges strictly — an empty one would refuse with a generic text, never explain) and every allowance is exactly {ok:true}', () => {
  const refusals: Array<[string, unknown]> = [
    ...[...PROFILE_REFUSED_CDP_METHODS.keys()].map((m): [string, unknown] => [m, {}]),
    ['Network.getCookies', { urls: ['https://x.org/'] }], ['Network.getCookies', { urls: 3 }], ['Network.deleteCookies', { name: 'a', domain: 'x.org' }],
    ['Network.setCookie', { name: 'a', value: 'b', url: 'https://x.org/' }], ['Network.setCookies', { cookies: [{ url: 'https://x.org/' }] }], ['Network.setCookies', { cookies: null }],
    ['Storage.setCookies', { cookies: [{ domain: 'x.org' }] }], ['Network.setCookieControls', {}],
  ];
  for (const [method, params] of refusals) {
    const r = cdp(method, params);
    assert.equal(r.ok, false, `${method} ${JSON.stringify(params)}`);
    assert.equal(typeof (r as { message: unknown }).message, 'string');
    assert.ok((r as { message: string }).message.trim().length > 20, `${method}: a real sentence, not ''`);
  }
  for (const [method, params] of [['Runtime.evaluate', {}], ['Network.getCookies', { urls: [PAGE] }], ['Page.navigate', { url: 'https://x.org/' }], ['Network.deleteCookies', { name: 'a', url: PAGE }]] as Array<[string, unknown]>) {
    assert.deepEqual(cdp(method, params), { ok: true });
  }
});
