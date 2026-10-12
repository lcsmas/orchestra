// The service worker (#336): home-screen install + the « Orchestra injoignable » page when the server is down. It caches ONLY the
// static shell (SHELL_PATHS) — never /api/*, never a request carrying the token (the token lives in the page's localStorage and in
// the Authorization header of /api calls, which the worker does not even see). Network first: a reachable server always wins, so a
// stale shell can only be shown when Orchestra really is unreachable. Served by server.ts behind the identity check like every asset.

import { PWA_ICONS } from './icons.ts';

/** Everything the worker may cache. server.ts must serve each of these (server.test.ts pins it). */
// conversation.js/.css too (#337): app.js needs conversation.js to even render « Orchestra injoignable » offline; launch.js/.css (#375) likewise —
// the shell's header carries the « + » and its route.
export const SHELL_PATHS: readonly string[] = ['/', '/app.js', '/conversation.js', '/conversation.css', '/launch.js', '/launch.css', '/manifest.webmanifest', ...PWA_ICONS.map((i) => i.path)];

export const SW_CACHE_NAME = 'orchestra-shell-v1';

export const SW_JS = `(function () {
  'use strict';
  var CACHE = ${JSON.stringify(SW_CACHE_NAME)};
  var SHELL = ${JSON.stringify(SHELL_PATHS)};
  var TIMEOUT_MS = 6000;
  var UNREACHABLE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestra</title>' +
    '<body style="font:16px -apple-system,system-ui,sans-serif;margin:24px"><h1 style="font-size:20px">Orchestra injoignable</h1>' +
    '<p>L\\u2019app est fermée, Accès mobile est coupé, ou ce téléphone est hors du tailnet.</p>';

  self.addEventListener('install', function (e) {
    // addAll rejects on any non-2xx: an error page is never cached, and a failed install simply retries on the next load.
    e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
  });

  self.addEventListener('activate', function (e) {
    e.waitUntil(caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); }));
  });

  function fromCache(key) { return caches.open(CACHE).then(function (c) { return c.match(key); }); }
  function unreachablePage() { return new Response(UNREACHABLE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }

  function networkFirst(key, isNav, e) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    return fetch(key, { cache: 'no-store', signal: ctl.signal }).then(function (res) {
      clearTimeout(timer);
      if (res.status === 200) {
        var copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(function (c) { return c.put(key, copy); }));
        return res;
      }
      // 5xx = tailscale serve with nothing behind it (app closed / Accès mobile off): show the cached shell. A 4xx (wrong identity…) is the
      // server's own answer and is never masked.
      if (res.status >= 500) return fromCache(key).then(function (hit) { return hit || (isNav ? unreachablePage() : res); });
      return res;
    }, function () {
      clearTimeout(timer);
      return fromCache(key).then(function (hit) { return hit || (isNav ? unreachablePage() : Response.error()); });
    });
  }

  self.addEventListener('fetch', function (e) {
    var req = e.request;
    if (req.method !== 'GET') return;
    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.indexOf('/api/') === 0) return; // data (and the token that unlocks it) never goes through the cache
    var isNav = req.mode === 'navigate';
    if (isNav ? url.pathname !== '/' : SHELL.indexOf(url.pathname) < 0) return;
    e.respondWith(networkFirst(url.pathname, isNav, e));
  });
})();
`;
