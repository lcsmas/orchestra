import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_PROFILE_NAME_MAX,
  checkProfileName,
  cdpSiteTargets,
  decideAgentCdp,
  isPageSite,
  decideAgentClear,
  decideAttach,
  decideDelete,
  effectiveProfileId,
  ephemeralPartition,
  isBrowserProfileId,
  isHumanProfileCaller,
  normalizeBrowserProfiles,
  PROFILE_REFUSED_CDP_METHODS,
  partitionFor,
  profileCreateWarning,
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

test('profileCreateWarning: only when secret storage is not encrypted (reuses #389)', () => {
  assert.equal(profileCreateWarning(null), null);
  assert.equal(profileCreateWarning({ encrypted: true, backend: 'gnome_libsecret', plaintextEntries: 0, encryptedEntries: 2 }), null);
  const w = profileCreateWarning({ encrypted: false, backend: 'basic_text', plaintextEntries: 1, encryptedEntries: 0 });
  assert.match(w ?? '', /not encrypted/);
  assert.match(profileCreateWarning({ encrypted: false, backend: null, plaintextEntries: 0, encryptedEntries: 3 }) ?? '', /not encrypted/);
});

test('decideAgentCdp: partition-wide / origin-wide clears and partition-wide cookie reads are refused for a profile workspace, never for an ephemeral one; targeted ops pass', () => {
  assert.deepEqual([...PROFILE_REFUSED_CDP_METHODS.keys()].sort(), [
    'Network.clearBrowserCookies', 'Network.getAllCookies', 'Storage.clearCookies', 'Storage.clearDataForOrigin', 'Storage.clearDataForStorageKey', 'Storage.getCookies',
  ]);
  for (const [method, kind] of PROFILE_REFUSED_CDP_METHODS) {
    const r = decideAgentCdp({ method, profileId: A });
    assert.equal(r.ok, false, method);
    assert.match((r as { message: string }).message, kind === 'clear' ? /sign them all out/ : /expose sign-ins beyond this page/, method);
    assert.deepEqual(decideAgentCdp({ method, profileId: undefined }), { ok: true }, `${method} on an ephemeral workspace`);
  }
  for (const method of ['Network.deleteCookies', 'Network.setCookie', 'Network.getCookies', 'Storage.getStorageKeyForFrame', 'Runtime.evaluate', 'Page.navigate']) {
    assert.deepEqual(decideAgentCdp({ method, profileId: A }), { ok: true }, `${method} names what it touches`);
  }
  assert.equal(decideAgentClear, decideAgentCdp, 'the first interface name still resolves');
});

const PAGE = 'https://app.example.com/dashboard';
// `null` = an ephemeral workspace (a default parameter would swallow an `undefined`)
const cdp = (method: string, params: unknown, pageUrl: string | undefined = PAGE, profileId: string | null = A) => decideAgentCdp({ method, params, profileId: profileId ?? undefined, pageUrl });

test('isPageSite: the page\'s own host or a parent domain of it — never a sibling, a bare TLD, another site, or a blank page', () => {
  assert.equal(isPageSite(PAGE, 'https://app.example.com/x'), true);
  assert.equal(isPageSite(PAGE, '.example.com'), true, 'a domain cookie the page itself could set');
  assert.equal(isPageSite(PAGE, 'example.com'), true);
  assert.equal(isPageSite(PAGE, 'https://example.com/'), true);
  assert.equal(isPageSite(PAGE, 'https://admin.example.com/'), false, 'a sibling subdomain');
  assert.equal(isPageSite(PAGE, 'https://other.org/'), false);
  assert.equal(isPageSite(PAGE, 'com'), false, 'a bare TLD');
  assert.equal(isPageSite(PAGE, 'https://evilexample.com/'), false, 'a different site that merely looks similar');
  assert.equal(isPageSite('https://notexample.com/', 'example.com'), false, 'the PAGE host ends with the target but not on a dot boundary');
  assert.equal(isPageSite('https://notexample.com/', '.example.com'), false);
  assert.equal(isPageSite('https://a.example.com/', 'example.com'), true, 'control: on a dot boundary it is the parent domain');
  assert.equal(isPageSite('http://localhost:3000/', 'http://localhost:9/'), true);
  assert.equal(isPageSite('http://127.0.0.1:1/', 'http://127.0.0.1:2/'), true);
  assert.equal(isPageSite('about:blank', 'https://example.com/'), false, 'a page with no host owns no site');
  assert.equal(isPageSite(undefined, 'https://example.com/'), false);
  assert.equal(isPageSite(PAGE, ''), false);
  assert.equal(isPageSite(PAGE, 'http://[bad'), false, 'an unparsable target');
});

test('cdpSiteTargets: what each site-scoped method names; malformed params = null', () => {
  assert.deepEqual(cdpSiteTargets('Network.getCookies', {}), [], 'no urls = the page\'s own');
  assert.deepEqual(cdpSiteTargets('Network.getCookies', { urls: ['https://a.com/', 'https://b.com/'] }), ['https://a.com/', 'https://b.com/']);
  assert.equal(cdpSiteTargets('Network.getCookies', { urls: 'https://a.com/' }), null);
  assert.equal(cdpSiteTargets('Network.getCookies', { urls: [1] }), null);
  assert.deepEqual(cdpSiteTargets('Network.deleteCookies', { name: 'x', url: 'https://a.com/', domain: 'b.com' }), ['https://a.com/', 'b.com']);
  assert.deepEqual(cdpSiteTargets('Network.setCookie', { name: 'x', value: 'y' }), []);
  assert.equal(cdpSiteTargets('Network.setCookie', { url: 5 }), null);
  assert.deepEqual(cdpSiteTargets('Network.setCookies', { cookies: [{ name: 'a', url: 'https://a.com/' }, { name: 'b', domain: 'c.com' }] }), ['https://a.com/', 'c.com']);
  assert.equal(cdpSiteTargets('Network.setCookies', { cookies: 'nope' }), null);
  assert.equal(cdpSiteTargets('Network.setCookies', { cookies: [null] }), null);
  assert.deepEqual(cdpSiteTargets('Runtime.evaluate', { expression: 'x' }), []);
  assert.deepEqual(cdpSiteTargets('Network.getCookies', undefined), []);
});

test('decideAgentCdp (site scope): another site\'s cookies are refused for a profile workspace on every named-site method; the page\'s own site and a no-url read pass; ephemeral never refused', () => {
  const other = 'https://prod-admin.other.org/';
  for (const [method, params] of [
    ['Network.getCookies', { urls: [other] }],
    ['Network.getCookies', { urls: [PAGE, other] }],
    ['Network.deleteCookies', { name: 'sid', url: other }],
    ['Network.deleteCookies', { name: 'sid', domain: '.other.org' }],
    ['Network.setCookie', { name: 'sid', value: 'x', url: other }],
    ['Network.setCookies', { cookies: [{ name: 'a', url: PAGE }, { name: 'b', url: other }] }],
    ['Network.getCookies', { urls: 'not-an-array' }],
  ] as Array<[string, unknown]>) {
    const r = cdp(method, params);
    assert.equal(r.ok, false, `${method} ${JSON.stringify(params)}`);
    assert.match((r as { message: string }).message, /site other than the page you are on/);
    assert.deepEqual(cdp(method, params, PAGE, null), { ok: true }, 'ephemeral workspace');
  }
  for (const [method, params] of [
    ['Network.getCookies', {}],
    ['Network.getCookies', { urls: [PAGE] }],
    ['Network.getCookies', { urls: ['https://example.com/'] }],
    ['Network.deleteCookies', { name: 'sid', url: PAGE }],
    ['Network.deleteCookies', { name: 'sid', domain: '.example.com', path: '/' }],
    ['Network.setCookie', { name: 'a', value: 'b' }],
    ['Network.setCookies', { cookies: [{ name: 'a', url: PAGE }] }],
  ] as Array<[string, unknown]>) {
    assert.deepEqual(cdp(method, params), { ok: true }, `${method} ${JSON.stringify(params)}`);
  }
  assert.equal(cdp('Network.getCookies', { urls: [PAGE] }, 'about:blank').ok, false, 'a blank tab owns no site');
  assert.deepEqual(cdp('Runtime.evaluate', { expression: 'document.cookie' }), { ok: true }, 'in-page JS is the page\'s own business');
});

test('decideAgentCdp: EVERY refusal carries a NON-EMPTY string message (the proxy core judges truthiness — an empty one would fail OPEN) and every allowance is exactly {ok:true}', () => {
  const PAGE2 = 'https://app.example.com/';
  const refusals: Array<[string, unknown]> = [
    ...[...PROFILE_REFUSED_CDP_METHODS.keys()].map((m): [string, unknown] => [m, {}]),
    ['Network.getCookies', { urls: ['https://x.org/'] }], ['Network.getCookies', { urls: 3 }], ['Network.deleteCookies', { name: 'a', domain: 'x.org' }],
    ['Network.setCookie', { name: 'a', value: 'b', url: 'https://x.org/' }], ['Network.setCookies', { cookies: [{ url: 'https://x.org/' }] }], ['Network.setCookies', { cookies: null }],
  ];
  for (const [method, params] of refusals) {
    const r = decideAgentCdp({ method, params, profileId: A, pageUrl: PAGE2 });
    assert.equal(r.ok, false, `${method} ${JSON.stringify(params)}`);
    assert.equal(typeof (r as { message: unknown }).message, 'string');
    assert.ok((r as { message: string }).message.trim().length > 20, `${method}: a real sentence, not ''`);
  }
  for (const [method, params] of [['Runtime.evaluate', {}], ['Network.getCookies', {}], ['Page.navigate', { url: 'https://x.org/' }], ['Network.deleteCookies', { name: 'a', url: PAGE2 }]] as Array<[string, unknown]>) {
    assert.deepEqual(decideAgentCdp({ method, params, profileId: A, pageUrl: PAGE2 }), { ok: true });
  }
});
