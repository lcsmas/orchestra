#!/usr/bin/env python3
"""Accès mobile (#334, #336): remove each auth/bind/pairing/PWA clause in place, run the suite that owns it, require RED, restore byte-exact.
Usage: python3 -I scripts/acces-mobile-mutants.py [id-prefix ...]   (from the repo root; no argument = every mutant)
       E2E_RIG_BASE=<a dir OUTSIDE every live dir the rig guards> python3 -I scripts/acces-mobile-mutants.py --e2e [id ...]
                                                                     (BUILT-APP mutants: copy the tree under $ACCES_MOBILE_E2E_SCRATCH, mutate,
                                                                      rebuild the bundles, run scripts/e2e-acces-mobile.sh, require a red clause)"""
import os, shutil, subprocess, sys, filecmp

ROOT = os.getcwd()
TEST = 'src/acces-mobile/server.test.ts'
PWA = 'src/acces-mobile/pwa.test.ts'
PL = 'src/acces-mobile/page-list.test.ts'
TREE = 'src/shared/acces-mobile-tree.test.ts'
CSS = 'src/acces-mobile/page-css.test.ts'
CV = 'src/acces-mobile/conversation.ts'
PAIR = 'src/shared/acces-mobile-pairing.test.ts'
QR = 'src/shared/qr.test.ts'
TOKEN = 'src/main/acces-mobile-token.test.ts'
WIRING = 'src/main/acces-mobile-wiring.test.ts'
CLOSERACE = 'src/acces-mobile/conversation-close-race.test.ts'
FEEDCORE = 'src/main/acces-mobile-feed-core.test.ts'
LAUNCHUI = 'src/acces-mobile/launch.test.ts'
PAUSEW = 'src/main/pause-gates-wiring.test.ts'
SLAUNCH = 'src/acces-mobile/server-launch.test.ts'
MLAUNCH = 'src/main/acces-mobile-launch.test.ts'
SHLAUNCH = 'src/shared/acces-mobile-launch.test.ts'
MUTANTS = [
    # (id, file, original, replacement, expected) — expected 'RED' (must be killed) or 'EQUIV' (a second guard covers it)
    ('M1-no-allowed-login', 'src/acces-mobile/server.ts', "    if (!opts.allowedLogin) return refuse(403, 'no-allowed-login');\n", '', 'RED'),
    ('M2-missing-identity', 'src/acces-mobile/server.ts', "    if (typeof login !== 'string' || login === '') return refuse(403, 'no-identity');\n", "    if (typeof login !== 'string') { /* mutant */ }\n", 'RED'),
    ('M3-wrong-identity', 'src/acces-mobile/server.ts', "    if (!sameLogin(login, opts.allowedLogin)) return refuse(403, 'wrong-identity');\n", '', 'RED'),
    ('M4-bad-token', 'src/acces-mobile/server.ts', "    if (!tokenMatches(presented, expected)) return refuse(401, 'bad-token');\n", '', 'RED'),
    ('M5-no-token', 'src/acces-mobile/server.ts', "    if (!presented) return refuse(401, 'no-token');\n", '', 'RED'),
    ('M6-empty-expected', 'src/acces-mobile/server.ts', "  if (!presented || !expected) return false;\n", "  if (!presented) return false;\n", 'EQUIV'),  # sha256 of a non-empty token never equals sha256('')
    ('M7-login-substring', 'src/shared/acces-mobile.ts', "  return a.trim().toLowerCase() === b.trim().toLowerCase();\n", "  return a.trim().toLowerCase().startsWith(b.trim().toLowerCase());\n", 'RED'),
    ('M8-socket-world-open', 'src/acces-mobile/index.ts', "process.umask(0o177);\nserver.listen(sockPath, () => {\n  try {\n    fs.chmodSync(sockPath, 0o600); // belt and braces: umask already made it 0600\n", "process.umask(0o000);\nserver.listen(sockPath, () => {\n  try {\n", 'RED'),
    ('M8b-tcp-listener', 'src/acces-mobile/index.ts', "server.listen(sockPath, () => {", "require('node:net').createServer().listen(0, '127.0.0.1');\nserver.listen(sockPath, () => {", 'RED'),
    ('M8c-open-dir-accepted', 'src/acces-mobile/index.ts', " || (st.mode & 0o077) !== 0)", ")", 'RED'),
    ('M11-no-exit-with-parent', 'src/acces-mobile/index.ts', "process.stdin.on('end', () => exit(0));\nprocess.stdin.on('close', () => exit(0));\n", "", 'RED'),
    ('M12-entry-token-cached', 'src/acces-mobile/index.ts', "  readToken: () => fs.readFileSync(tokenFile, 'utf8'),", "  readToken: ((t: string) => () => t)(fs.readFileSync(tokenFile, 'utf8')),", 'RED'),
    ('M13-no-rate-limit', 'src/acces-mobile/server.ts', "    if (b.count < REFUSAL_LOG_BURST) {", "    if (true) {", 'RED'),
    ('M14-no-csp', 'src/acces-mobile/server.ts', "  'Content-Security-Policy':", "  'X-Removed-CSP':", 'RED'),
    ('M15-token-dir-not-chmod', 'src/main/acces-mobile-token.ts', "  fs.chmodSync(dir, 0o700);\n", "", 'RED', 'src/main/acces-mobile-token.test.ts'),
    ('M16-boot-unguarded', 'src/main/acces-mobile-host.ts', "export function startAccesMobileHost(): void {\n  try {\n    applyAccesMobile(store.getAccesMobileSettings());\n  } catch (e) {\n    log.warn('Accès mobile could not start — the app boots without it', e);\n  }\n}", "export function startAccesMobileHost(): void {\n  applyAccesMobile(store.getAccesMobileSettings());\n}", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('Y1-non-socket-unlinked', 'src/acces-mobile/index.ts', "  if (!old.isSocket()) fail(`${sockPath} exists and is not a socket`);\n", "", 'RED'),
    ('Y2-no-fd-wrapper', 'src/main/acces-mobile-host.ts', "  const viaBash = process.platform === 'linux' && fs.existsSync('/bin/bash');", "  const viaBash = false;", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('Y3-wrapper-closes-nothing', 'src/shared/acces-mobile.ts', 'if [ "$n" -gt 3 ]; then', 'if [ "$n" -gt 99999 ]; then', 'RED'),
    ('Y3b-wrapper-closes-the-channel', 'src/shared/acces-mobile.ts', 'if [ "$n" -gt 3 ]; then', 'if [ "$n" -gt 2 ]; then', 'RED'),
    ('Y4-retry-catch-removed', 'src/main/acces-mobile-host.ts', "  try {\n    startChild(s);\n  } catch (e) {\n    const msg = e instanceof Error ? e.message : String(e);\n    log.warn(`server start failed: ${msg}`);\n    child = null;\n    childKey = '';\n    scheduleRetry(msg);\n  }", "  startChild(s);", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('Y5-dir-owner-unchecked', 'src/acces-mobile/index.ts', "st.uid !== process.getuid?.() || ", "", 'RED'),
    ('Y9-no-unlink-on-exit', 'src/acces-mobile/index.ts', "    if (bound !== null && identity(fs.lstatSync(sockPath, { bigint: true })) === bound) fs.unlinkSync(sockPath);\n", "", 'RED'),
    ('Y9b-unlink-by-path', 'src/acces-mobile/index.ts', "    if (bound !== null && identity(fs.lstatSync(sockPath, { bigint: true })) === bound) fs.unlinkSync(sockPath);", "    fs.unlinkSync(sockPath);", 'RED'),
    ('Y10-xdg-trusted', 'src/shared/acces-mobile.ts', "    if (st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0) return runtimeDir;", "    if (st.isDirectory()) return runtimeDir;", 'RED'),
    ('Y11-shared-budget', 'src/acces-mobile/server.ts', "    let b = budgets.get(reason);\n    if (!b) budgets.set(reason,", "    let b = budgets.get('all');\n    if (!b) budgets.set('all',", 'RED'),
    ('Y12-server-close-on-exit', 'src/acces-mobile/index.ts', "function exit(code: number): never {\n  try {\n", "function exit(code: number): never {\n  try {\n    server.close();\n", 'RED'),
    ('C1-stream-no-recheck', 'src/acces-mobile/server.ts', "        if (!tokenMatches(presented, readTokenSafe())) close();\n", "", 'RED'),
    ('C2-seen-on-get', 'src/acces-mobile/server.ts', "    if (pathOnly === '/api/seen' && method === 'POST') {", "    if (pathOnly === '/api/seen') {", 'RED'),
    ('C3-relay-any-kind', 'src/acces-mobile/server.ts', "          else if (t === 'conv' || t === 'workspaces') res.write", "          else res.write", 'RED'),
    ('C4-no-stream-cap', 'src/acces-mobile/server.ts', "      if (openStreams >= MAX_STREAMS) return refuse(429, 'too-many-streams');", "      if (false) return refuse(429, 'too-many-streams');", 'RED'),
    ('C5-miss-not-recorded', 'src/main/acces-mobile-feed-core.ts', "      e.missedWhileLoading = true;\n", "", 'RED', 'src/main/acces-mobile-feed-core.test.ts'),
    ('C6-reload-every-turn', 'src/main/acces-mobile-feed-core.ts', "    if (event.type === 'turn-end' && e.missedWhileLoading) e.reloadPending = true;", "    if (event.type === 'turn-end') e.reloadPending = true;", 'RED', 'src/main/acces-mobile-feed-core.test.ts'),
    ('C7-ask-not-recognized', 'src/shared/acces-mobile-conversation.ts', "a.name === 'AskUserQuestion'", "a.name === 'AskUserQuestionX'", 'RED', 'src/shared/acces-mobile-conversation.test.ts'),
    ('C8-id-unvalidated', 'src/acces-mobile/server.ts', "      return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;", "      return id || null;", 'RED'),
    ('C9-tap-never-disarmed', 'src/main/acces-mobile-feed-core.ts', "  untap?.();\n  untap = null;\n", "", 'RED', 'src/main/acces-mobile-feed-core.test.ts'),
    ('P1-send-via-agent-path', 'src/main/acces-mobile-routes.ts', "          await sdkSend(ws.id, text, atts.images.length ? atts.images : undefined, undefined, undefined, false, false, 'human');", "          await dispatchMessageRequest({ to: ws.id, text } as never);", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('P1b-mobile-route-on-hooks-socket', 'src/main/hooks-server.ts', "          } else if (route === '/accounts') {", "          } else if (route === '/mobile/send') { send(200, {});\n          } else if (route === '/accounts') {", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('P1c-server-told-the-hooks-socket', 'src/main/acces-mobile-host.ts', "    ELECTRON_RUN_AS_NODE: '1',", "    ELECTRON_RUN_AS_NODE: '1',\n    ORCHESTRA_SOCK: process.env.ORCHESTRA_SOCK ?? '',", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('P1d-entry-without-channel-check', 'src/acces-mobile/index.ts', "  if (!fs.fstatSync(3).isSocket()) fail('fd 3 is not the main channel');\n", "", 'EQUIV'),  # new net.Socket({fd:3}) throws EBADF on a missing fd anyway
    ('P2-no-body-cap', 'src/acces-mobile/server.ts', "        if (size > maxBytes) {", "        if (false) {", 'RED'),
    ('P3-archived-accepted', 'src/main/acces-mobile-routes.ts', "  return ws && !ws.archived ? ws : undefined;", "  return ws;", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('P4-any-content-type', 'src/acces-mobile/server.ts', "      if (!/^application\\/json\\b/i.test(String(req.headers['content-type'] ?? ''))) return refuse(415, 'not-json');\n", "", 'RED'),
    ('P5-short-send-timeout', 'src/acces-mobile/server.ts', "        relay('/mobile/send', atts.images.length ? { id, text, attachments: atts.images } : { id, text }, 45_000);", "        relay('/mobile/send', atts.images.length ? { id, text, attachments: atts.images } : { id, text });", 'RED'),
    ('P6-blank-accepted', 'src/acces-mobile/server.ts', "        if (typeof text !== 'string' || (!text.trim() && !atts.images.length) || text.length > MOBILE_SEND_MAX_CHARS) return refuse(400, 'bad-text');", "        if (typeof text !== 'string') return refuse(400, 'bad-text');", 'RED'),
    ('K1-rpc-replies-crossed', 'src/shared/acces-mobile-rpc.ts', "      const c = calls.get(m.id);", "      const c = calls.get(Math.min(...calls.keys()));", 'RED', 'src/shared/acces-mobile-rpc.test.ts'),
    ('K2-rpc-streams-leak-on-close', 'src/shared/acces-mobile-rpc.ts', "    for (const [, off] of subs) off();\n", "", 'RED', 'src/shared/acces-mobile-rpc.test.ts'),
    ('K3-rpc-cancel-ignored', 'src/shared/acces-mobile-rpc.ts', "          subs.get(id)?.();\n", "", 'RED', 'src/shared/acces-mobile-rpc.test.ts'),
    ('K5-rpc-no-utf8-decoder', 'src/shared/acces-mobile-rpc.ts', "    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);", "    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');", 'RED', 'src/shared/acces-mobile-rpc.test.ts'),
    ('K6-rpc-calls-uncapped', 'src/shared/acces-mobile-rpc.ts', "        if (inFlight >= MAX_CALLS_IN_FLIGHT) return send({ id, result: { ok: false, error: 'busy' } });\n", "", 'RED', 'src/shared/acces-mobile-rpc.test.ts'),
    ('K7-rpc-death-unreported', 'src/shared/acces-mobile-rpc.ts', "    streams.clear();\n    onDead?.();\n", "    streams.clear();\n", 'RED', 'src/shared/acces-mobile-rpc.test.ts'),
    ('C10-ask-question-clipped', 'src/shared/acces-mobile-conversation.ts', "          question: typeof q.question === 'string' ? q.question : '',", "          question: typeof q.question === 'string' ? clip(q.question, 1000) : '',", 'RED', 'src/shared/acces-mobile-conversation.test.ts'),
    ('K4-writes-uncapped', 'src/acces-mobile/server.ts', "        if (writesInFlight >= MAX_WRITES_IN_FLIGHT) return refuse(429, 'too-many-writes');", "        if (false) return refuse(429, 'too-many-writes');", 'RED'),
    ('M9-token-read-once', 'src/acces-mobile/server.ts', "    const expected = readTokenSafe();\n", "    const expected = ((globalThis as any).__t ??= readTokenSafe()) as string;\n", 'RED'),
    # ── #336: pairing URL / QR / regenerate / PWA ──
    ('Q1-url-token-in-query', 'src/shared/acces-mobile.ts', "return `https://${host}:${servePort}/#t=${token}`;", "return `https://${host}:${servePort}/?t=${token}`;", 'RED', PAIR),
    ('Q2-url-ignores-serve-port', 'src/shared/acces-mobile.ts', "return `https://${host}:${servePort}/#t=${token}`;", "return `https://${host}:8445/#t=${token}`;", 'RED', PAIR),
    ('Q3-url-token-unvalidated', 'src/shared/acces-mobile.ts', "if (!host || !token || !PAIRING_TOKEN.test(token)) return null;", "if (!host || !token) return null;", 'RED', PAIR),
    ('Q4-host-unvalidated', 'src/shared/acces-mobile.ts', "if (labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) return null;", "if (labels.length < 1) return null;", 'RED', PAIR),
    ('Q4b-host-ip-accepted', 'src/shared/acces-mobile.ts', "  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;\n", "", 'RED', PAIR),
    ('Q5-qr-no-quiet-zone', 'src/shared/qr.ts', "export const QR_MARGIN = 4;", "export const QR_MARGIN = 0;", 'RED', QR),
    ('Q6-qr-encodes-truncated-text', 'src/shared/qr.ts', "QRCode.create(text, {", "QRCode.create(text.slice(0, 40), {", 'RED', QR),
    ('Q7-qr-run-drops-its-last-module', 'src/shared/qr.ts', "while (end < row.length && row[end]) end++;", "while (end < row.length - 1 && row[end]) end++;", 'RED', QR),
    ('Q7b-qr-zero-height-modules', 'src/shared/qr.ts', "h${end - x}v1h-${end - x}z", "h${end - x}v0h-${end - x}z", 'RED', QR),
    ('Q7c-qr-transposed-matrix', 'src/shared/qr.ts', "modules.get(r, c) === 1", "modules.get(c, r) === 1", 'EQUIV', QR),  # a diagonal mirror of a QR symbol decodes: readers (jsQR included) accept mirrored codes
    ('Q7d-qr-skipped-light-module', 'src/shared/qr.ts', "      x = end;\n", "      x = end + 1;\n", 'EQUIV', QR),  # row[end] is light by the loop's own exit, so skipping it changes nothing
    ('Q8-ui-qr-encodes-fragment-only', 'src/renderer/components/AccesMobileSettings.tsx', "<AccesMobileQr text={view.pairingUrl} />", "<AccesMobileQr text={view.pairingFragment ?? ''} />", 'RED', WIRING),
    ('Q9-view-url-from-fragment', 'src/main/acces-mobile-host.ts', "    pairingUrl: pairingUrl(settings.tailnetHost, settings.servePort, token),", "    pairingUrl: token ? `#t=${token}` : null,", 'RED', WIRING),
    ('R1-regenerate-keeps-token', 'src/main/acces-mobile-token.ts', "  const token = crypto.randomBytes(32).toString('base64url');", "  const token = readTokenIn(dir) ?? crypto.randomBytes(32).toString('base64url');", 'RED', TOKEN),
    ('R2-regenerate-never-lands', 'src/main/acces-mobile-token.ts', "  fs.renameSync(tmp, tokenFileIn(dir));\n", "", 'RED', TOKEN),
    ('R3-regenerate-ipc-unhandled', 'src/main/api-handlers.ts', "  regenerateAccesMobileToken: async () => regenerateAccesMobileToken(),\n", "", 'RED', WIRING),
    ('R4-regenerate-logs-token', 'src/main/acces-mobile-host.ts', "  generateAccesMobileToken();\n  log.info('pairing token regenerated — the previous token is refused from now on');", "  const t = generateAccesMobileToken();\n  log.info(`pairing token regenerated ${t}`);", 'RED', WIRING),
    ('R5-regenerate-button-gone', 'src/renderer/components/AccesMobileSettings.tsx', "data-am-regenerate disabled={regenerating}", "data-am-gone disabled={regenerating}", 'RED', WIRING),
    ('R6-host-runs-tailscale', 'src/main/acces-mobile-host.ts', "const log = scoped('acces-mobile');", "const log = scoped('acces-mobile');\nvoid spawn('tailscale', ['status', '--json']);", 'RED', WIRING),
    ('S1-sw-no-allowlist', 'src/acces-mobile/sw.ts', "    if (isNav ? url.pathname !== '/' : SHELL.indexOf(url.pathname) < 0) return;\n", "    if (isNav && url.pathname !== '/') return;\n", 'RED', PWA),
    ('S1b-sw-api-guard-removed', 'src/acces-mobile/sw.ts', "    if (url.pathname.indexOf('/api/') === 0) return; // data (and the token that unlocks it) never goes through the cache\n", "", 'EQUIV', PWA),  # the shell allowlist below it also refuses /api/*
    ('S1c-sw-no-api-guard-no-allowlist', 'src/acces-mobile/sw.ts', "    if (url.pathname.indexOf('/api/') === 0) return; // data (and the token that unlocks it) never goes through the cache\n    var isNav = req.mode === 'navigate';\n    if (isNav ? url.pathname !== '/' : SHELL.indexOf(url.pathname) < 0) return;\n", "    var isNav = req.mode === 'navigate';\n", 'RED', PWA),
    ('S1d-api-in-shell-paths', 'src/acces-mobile/sw.ts', "'/manifest.webmanifest', ...PWA_ICONS.map((i) => i.path)];", "'/manifest.webmanifest', '/api/workspaces', ...PWA_ICONS.map((i) => i.path)];", 'RED', PWA),
    ('S2-sw-never-refreshes-cache', 'src/acces-mobile/sw.ts', "        e.waitUntil(caches.open(CACHE).then(function (c) { return c.put(key, copy); }));\n", "", 'RED', PWA),
    ('S3-sw-masks-4xx', 'src/acces-mobile/sw.ts', "      if (res.status >= 500) return fromCache", "      if (res.status >= 400) return fromCache", 'RED', PWA),
    ('S4-sw-caches-error-pages', 'src/acces-mobile/sw.ts', "      if (res.status === 200) {\n        var copy", "      if (res.status >= 200) {\n        var copy", 'RED', PWA),
    ('S5-sw-no-cache-on-network-error', 'src/acces-mobile/sw.ts', "      return fromCache(key).then(function (hit) { return hit || (isNav ? unreachablePage() : Response.error()); });\n    });", "      return isNav ? unreachablePage() : Response.error();\n    });", 'RED', PWA),
    ('S6-sw-keeps-the-query', 'src/acces-mobile/sw.ts', "e.respondWith(networkFirst(url.pathname, isNav, e));", "e.respondWith(networkFirst(url.pathname + url.search, isNav, e));", 'RED', PWA),
    ('S7-sw-no-timeout', 'src/acces-mobile/sw.ts', "setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);", "setTimeout(function () {}, TIMEOUT_MS);", 'RED', PWA),
    ('S8-sw-no-unreachable-page', 'src/acces-mobile/sw.ts', "hit || (isNav ? unreachablePage() : Response.error())", "hit || Response.error()", 'RED', PWA),
    ('S9-sw-precaches-error-pages', 'src/acces-mobile/sw.ts', "return c.addAll(SHELL);", "return Promise.all(SHELL.map(function (p) { return fetch(p).then(function (r) { return c.put(p, r); }); }));", 'RED', PWA),
    ('S10-sw-keeps-stale-caches', 'src/acces-mobile/sw.ts', "return caches.delete(k);", "return null;", 'RED', PWA),
    ('S11-sw-forwards-request-headers', 'src/acces-mobile/sw.ts', "return fetch(key, { cache: 'no-store', signal: ctl.signal })", "return fetch(key, { cache: 'no-store', signal: ctl.signal, headers: e.request.headers })", 'RED', PWA),
    ('I1-icons-before-identity', 'src/acces-mobile/server.ts', "    const login = req.headers['tailscale-user-login'];\n", "    const png0 = STATIC[pathOnly]; if (png0 && png0.type === 'image/png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png0.body); return; }\n    const login = req.headers['tailscale-user-login'];\n", 'RED', PWA),
    ('I2-sw-before-identity', 'src/acces-mobile/server.ts', "    const login = req.headers['tailscale-user-login'];\n", "    if (pathOnly === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(STATIC['/sw.js'].body); return; }\n    const login = req.headers['tailscale-user-login'];\n", 'RED', PWA),
    ('I3-shell-embeds-the-token', 'src/acces-mobile/server.ts', "      res.end(asset.body);\n", "      res.end(typeof asset.body === 'string' ? asset.body + '<!-- ' + opts.readToken() + ' -->' : asset.body);\n", 'RED', PWA),
    ('I4-manifest-without-icons', 'src/acces-mobile/page.ts', "  icons: MANIFEST_ICONS,\n", "", 'RED', PWA),
    ('I5-no-apple-touch-icon', 'src/acces-mobile/page.ts', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n', "", 'RED', PWA),
    ('I6-no-sw-registration', 'src/acces-mobile/page.ts', "  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});\n", "", 'RED', PWA),
    ('I7-page-keeps-the-fragment', 'src/acces-mobile/page.ts', "    history.replaceState(null, '', location.pathname);\n", "", 'RED', PWA),
    ('I8-icon-wrong-size', 'src/acces-mobile/icons.ts', "{ path: '/icon-192.png', size: 192,", "{ path: '/icon-192.png', size: 193,", 'RED', PWA),
    ('I10-no-repair-on-hashchange', 'src/acces-mobile/page.ts', "    if (pairFromHash()) {\n      try { token = localStorage.getItem(KEY); } catch (e) {}\n      conv.connect();\n      route();\n      return;\n    }\n", "", 'RED', PWA),
    ('I10b-hashchange-keeps-old-token', 'src/acces-mobile/page.ts', "      try { token = localStorage.getItem(KEY); } catch (e) {}\n      conv.connect();", "      conv.connect();", 'RED', PWA),
    ('I11-401-keeps-the-list', 'src/acces-mobile/page.ts', "{ last = []; listEl.textContent = ''; setState('Jeton refusé", "{ setState('Jeton refusé", 'RED', PWA),
    ('I9-refusal-log-has-the-query', 'src/acces-mobile/server.ts', "${method} ${pathOnly.slice(0, 80)}`);", "${method} ${(req.url ?? '').slice(0, 200)}`);", 'RED', PWA),
    ('M10-shell-without-identity', 'src/acces-mobile/server.ts', "    const login = req.headers['tailscale-user-login'];\n", "    const asset0 = STATIC[pathOnly]; if (asset0) { res.writeHead(200); res.end(asset0.body); return; }\n    const login = req.headers['tailscale-user-login'];\n", 'RED'),
    # ── 2026-10-12 feedback: Markdown on the phone, workers folded under their coordinator ──
    ('D1-md-any-link-scheme', 'src/shared/mini-markdown.ts', "          if (/^https?:\\/\\/\\S+$/.test(href)) {", "          if (href) {", 'RED', 'src/shared/mini-markdown.test.ts'),
    ('D2-md-snake-case-italic', 'src/shared/mini-markdown.ts', "        if (c === '*' || !/[A-Za-z0-9]/.test(before)) {", "        if (true) {", 'RED', 'src/shared/mini-markdown.test.ts'),
    ('D3-md-table-separator-kept', 'src/shared/mini-markdown.ts', "        if (cells.every((x) => /^:?-+:?$/.test(x))) continue;", "        if (false) continue;", 'RED', 'src/shared/mini-markdown.test.ts'),
    # ── 2026-10-12: files attached on the phone (images + PDFs) ──
    ('A1-any-media-type', 'src/shared/acces-mobile-conversation.ts', "    if (typeof mediaType !== 'string' || !MOBILE_ATTACH_TYPES.includes(mediaType)) return", "    if (typeof mediaType !== 'string') return", 'RED', 'src/shared/acces-mobile-conversation.test.ts'),
    ('A2-no-count-cap', 'src/shared/acces-mobile-conversation.ts', "  if (raw.length > MOBILE_ATTACH_MAX_COUNT) return", "  if (false) return", 'RED', 'src/shared/acces-mobile-conversation.test.ts'),
    ('A3-base64-unchecked', 'src/shared/acces-mobile-conversation.ts', "    if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return", "    if (typeof data !== 'string') return", 'RED', 'src/shared/acces-mobile-conversation.test.ts'),
    ('A4-small-cap-on-send', 'src/acces-mobile/server.ts', "      }, MOBILE_ATTACH_MAX_BODY);", "      });", 'RED'),
    ('A5-big-cap-everywhere', 'src/acces-mobile/server.ts', "        if (size > maxBytes) {", "        if (size > MOBILE_ATTACH_MAX_BODY) {", 'RED'),
    ('A6-server-drops-files', 'src/acces-mobile/server.ts', "        relay('/mobile/send', atts.images.length ? { id, text, attachments: atts.images } : { id, text }, 45_000);", "        relay('/mobile/send', { id, text }, 45_000);", 'RED'),
    ('A7-files-alone-refused', 'src/acces-mobile/server.ts', "(!text.trim() && !atts.images.length)", "!text.trim()", 'RED'),
    ('A8-main-trusts-the-server', 'src/main/acces-mobile-routes.ts', "        const atts = parseMobileAttachments(msg.attachments);\n        if (!atts.ok) return { ok: false, error: atts.error };\n", "        const atts = { images: (msg.attachments ?? []) as never[] };\n", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('A9-bubble-without-files', 'src/shared/acces-mobile-conversation.ts', "      if (atts.length) line.attachments = atts;\n", "", 'RED', 'src/shared/acces-mobile-conversation.test.ts'),
    # ── 2026-10-12: in-app pairing (an iOS home-screen app has its own storage) ──
    ('G1-token-from-query', 'src/shared/acces-mobile.ts', "const m = /[#&]t=([A-Za-z0-9_-]{16,256})(?:&|$)/.exec(s)", "const m = /[#&?]t=([A-Za-z0-9_-]{16,256})(?:&|$)/.exec(s)", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('G2-token-from-anything', 'src/shared/acces-mobile.ts', "|| /^([A-Za-z0-9_-]{16,256})$/.exec(s);", "|| /([A-Za-z0-9_-]{16,256})/.exec(s);", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('G3-401-no-repair-offer', 'src/acces-mobile/page.ts', "setState('Jeton refusé : re-scanne le QR code.'); showPair(true); return null;", "setState('Jeton refusé : re-scanne le QR code.'); return null;", 'RED', PWA),
    ('G4-unpaired-no-panel', 'src/acces-mobile/page.ts', "    if (!token) { setState('Pas appairé.'); showPair(true); return; }", "    if (!token) { setState('Pas appairé.'); return; }", 'RED', PWA),
    ('G5-decoder-not-served', 'src/acces-mobile/server.ts', "  '/jsqr.js': { type: 'text/javascript; charset=utf-8', body: jsqrSource() },\n", "", 'RED', PWA),
    # ── 2026-10-12: « Nouvelle version installée » + the phone stream's health ──
    ('U1-replaced-file-ignored', 'src/shared/app-update.ts', "  if (identityKey(boot) === identityKey(now)) return APP_UPDATE_NONE;", "  return APP_UPDATE_NONE;", 'RED', 'src/shared/app-update.test.ts'),
    ('U2-sidecar-of-another-file-trusted', 'src/shared/app-update.ts', "if (!m || Number(m[2]) !== now.ino || Number(m[3]) !== now.size) return null;", "if (!m) return null;", 'RED', 'src/shared/app-update.test.ts'),
    ('U3-relaunch-does-not-wait', 'src/shared/app-update.ts', "while kill -0 \"$1\" 2>/dev/null && [ \"$i\" -lt 600 ]; do", "while false; do", 'RED', 'src/shared/app-update.test.ts'),
    ('U4-push-on-every-check', 'src/main/app-update.ts', "      if (appUpdateStateKey(next) === appUpdateStateKey(state)) return;\n", "", 'RED', 'src/main/app-update.test.ts'),
    ('U5-mid-swap-hides-the-banner', 'src/main/app-update.ts', "      if (next.kind === 'none' && state.kind === 'installed' && !deps.stat(deps.path)) return;\n", "", 'RED', 'src/main/app-update.test.ts'),
    ('W1-silent-stream-kept', 'src/acces-mobile/conversation.ts', "      if (Date.now() - lastByte > STALL_MS) {", "      if (false) {", 'RED', 'src/acces-mobile/conversation-stream.test.ts'),
    # ── 2026-10-12 wave I (#372): the phone list shows the name without its repo prefix ──
    ('N1-repo-prefix-not-cut', 'src/shared/acces-mobile.ts', "[...(base ? [`${base} · `] : []), 'scratch · ', 'orchestrator · ']", "['scratch · ', 'orchestrator · ']", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N2-scratch-prefix-not-cut', 'src/shared/acces-mobile.ts', "[...(base ? [`${base} · `] : []), 'scratch · ', 'orchestrator · ']", "[...(base ? [`${base} · `] : []), 'orchestrator · ']", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N3-orchestrator-prefix-not-cut', 'src/shared/acces-mobile.ts', "[...(base ? [`${base} · `] : []), 'scratch · ', 'orchestrator · ']", "[...(base ? [`${base} · `] : []), 'scratch · ']", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N4-kind-prefix-before-repo', 'src/shared/acces-mobile.ts', "[...(base ? [`${base} · `] : []), 'scratch · ', 'orchestrator · ']", "['scratch · ', 'orchestrator · ', ...(base ? [`${base} · `] : [])]", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N5-empty-remainder-cut', 'src/shared/acces-mobile.ts', " && ws.name.length > prefix.length", "", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N6-cut-at-first-separator', 'src/shared/acces-mobile.ts', "if (ws.name.startsWith(prefix) && ws.name.length > prefix.length) return ws.name.slice(prefix.length);", "if (ws.name.includes(' · ')) return ws.name.slice(ws.name.indexOf(' · ') + 3);", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N7-trailing-slash-kept', 'src/shared/acces-mobile.ts', r"ws.repoPath.replace(/\/+$/, '').split('/').pop()", "ws.repoPath.split('/').pop()", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N8-display-name-not-projected', 'src/shared/acces-mobile.ts', "      displayName: mobileDisplayName(ws),\n", "      displayName: ws.name,\n", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N9-desktop-name-replaced', 'src/shared/acces-mobile.ts', "      name: ws.name,\n      displayName: mobileDisplayName(ws),\n", "      name: mobileDisplayName(ws),\n      displayName: mobileDisplayName(ws),\n", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N10-page-renders-the-full-name', 'src/acces-mobile/page.ts', "r1.appendChild(el('b', null, w.displayName || w.name));", "r1.appendChild(el('b', null, w.name));", 'RED', PL),
    ('N11-page-without-fallback', 'src/acces-mobile/page.ts', "r1.appendChild(el('b', null, w.displayName || w.name));", "r1.appendChild(el('b', null, w.displayName));", 'RED', PL),
    ('N12-waiting-row-loses-its-repo-chip', 'src/acces-mobile/page.ts', "    if (withRepo) r2.appendChild(el('span', 'repo', w.group));\n", "", 'RED', PL),
    ('N14-first-path-segment-is-the-repo', 'src/shared/acces-mobile.ts', r"ws.repoPath.replace(/\/+$/, '').split('/').pop()", r"ws.repoPath.replace(/\/+$/, '').split('/')[2]", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N15-sorted-by-the-desktop-name', 'src/shared/acces-mobile.ts', "a.displayName.localeCompare(b.displayName) || ", "", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('N16-conversation-title-full-name', 'src/acces-mobile/conversation.ts', "meta.displayName || meta.name || id", "meta.name || id", 'RED', PL),
    ('N13-stand-in-full-name', 'src/acces-mobile/page.ts', "document.createTextNode((n.row.displayName || n.row.name) + ' ')", "document.createTextNode(n.row.name + ' ')", 'RED', PL),
    ('N13-fold-owner-full-name', 'src/acces-mobile/page.ts', "name: byId[pid].displayName || byId[pid].name })", "name: byId[pid].name })", 'RED', PL),
    # ── 2026-10-12 wave I: launch a workspace from the phone (#375) ──
    ('LA1-launch-post-refused', 'src/acces-mobile/server.ts', " || pathOnly === '/api/launch'))) return refuse(405, 'method');", "))) return refuse(405, 'method');", 'RED', SLAUNCH),
    ('LA2-launch-body-unvalidated', 'src/acces-mobile/server.ts', "        if (!parsed.ok) return refuse(400, 'bad-launch');\n        relay('/mobile/launch', { ...parsed.launch }, MOBILE_LAUNCH_TIMEOUT_MS);", "        relay('/mobile/launch', body, MOBILE_LAUNCH_TIMEOUT_MS);", 'RED', SLAUNCH),
    ('LA3-launch-relays-raw-keys', 'src/acces-mobile/server.ts', "relay('/mobile/launch', { ...parsed.launch }, MOBILE_LAUNCH_TIMEOUT_MS);", "relay('/mobile/launch', { ...body, ...parsed.launch }, MOBILE_LAUNCH_TIMEOUT_MS);", 'RED', SLAUNCH),
    ('LA4-launch-short-timeout', 'src/acces-mobile/server.ts', "relay('/mobile/launch', { ...parsed.launch }, MOBILE_LAUNCH_TIMEOUT_MS);", "relay('/mobile/launch', { ...parsed.launch });", 'RED', SLAUNCH),
    ('LA5-launch-not-an-in-flight-write', 'src/acces-mobile/server.ts', " || route === '/mobile/launch';\n      if (isWrite) {", ";\n      if (isWrite) {", 'RED', SLAUNCH),
    ('LA13-prompt-optional', 'src/shared/acces-mobile-launch.ts', "  if (!prompt || prompt.length > MOBILE_LAUNCH_MAX_PROMPT) return", "  if (prompt.length > MOBILE_LAUNCH_MAX_PROMPT) return", 'RED', SHLAUNCH),
    ('LA14-prompt-not-trimmed', 'src/shared/acces-mobile-launch.ts', "typeof b.prompt === 'string' ? b.prompt.trim() : ''", "typeof b.prompt === 'string' ? b.prompt : ''", 'RED', SHLAUNCH),
    ('LA16-repo-path-nul', 'src/shared/acces-mobile-launch.ts', " || repoPath.includes('\\0'))", ")", 'RED', SHLAUNCH),
    ('LA17-extra-keys-travel', 'src/shared/acces-mobile-launch.ts', "return { ok: true, launch: { repoPath, prompt } };", "return { ok: true, launch: { ...b, repoPath, prompt } as MobileLaunchRequest };", 'RED', SHLAUNCH),
    ('LA18-repos-unsorted', 'src/shared/acces-mobile-launch.ts', "    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));", "    ;", 'RED', SHLAUNCH),
    ('LA19-repo-compte-ignored', 'src/shared/acces-mobile-launch.ts', "resolveWorkspaceAccountId(r.accountId, known)", "resolveWorkspaceAccountId(undefined, known)", 'RED', SHLAUNCH),
    ('LA20-unregistered-repo-created', 'src/main/acces-mobile-launch.ts', "      if (!deps.repos().some((r) => r.path === repoPath)) return Promise.resolve({ ok: false, code: 'unknown-repo', error: 'unknown repo' });\n", "", 'RED', MLAUNCH),
    ('LA21-repo-prefix-match', 'src/main/acces-mobile-launch.ts', "deps.repos().some((r) => r.path === repoPath)", "deps.repos().some((r) => repoPath.startsWith(r.path))", 'RED', MLAUNCH),
    ('LA29-spawn-gets-more-than-repo-and-task', 'src/main/acces-mobile-launch.ts', "res = await deps.spawn({ repoPath, task: prompt });", "res = await deps.spawn({ repoPath, task: prompt, model: 'x' } as never);", 'RED', MLAUNCH),
    ('LA30-start-failure-loses-the-id', 'src/main/acces-mobile-launch.ts', "return { ok: false, code: 'start-failed', id: res.id, ...(res.branch", "return { ok: false, code: 'start-failed', ...(res.branch", 'RED', MLAUNCH),
    ('LA31-start-failure-reads-ok', 'src/main/acces-mobile-launch.ts', "    if (res.id && res.ok) {", "    if (res.id) {", 'RED', MLAUNCH),
    ('LA32-main-trusts-the-server', 'src/main/acces-mobile-launch.ts', "      const parsed = parseMobileLaunch(raw);\n      if (!parsed.ok) return Promise.resolve({ ok: false, code: 'bad-request', error: parsed.error });\n      const { repoPath, prompt } = parsed.launch;", "      const { repoPath, prompt } = raw as { repoPath: string; prompt: string };", 'RED', MLAUNCH),
    ('LA33-launch-route-on-hooks-socket', 'src/main/hooks-server.ts', "          } else if (route === '/accounts') {", "          } else if (route === '/mobile/launch') { send(200, {});\n          } else if (route === '/accounts') {", 'RED', WIRING),
    ('LA34-launch-origin-auto', 'src/main/acces-mobile-routes.ts', "defaultKind: 'workspace', origin: 'human' })", "defaultKind: 'workspace' })", 'RED', PAUSEW),
    ('LA35-launch-origin-not-forwarded', 'src/main/workspaces.ts', "const started = await startWorkspaceAgentHeadless(ws.id, input.origin);", "const started = await startWorkspaceAgentHeadless(ws.id);", 'RED', PAUSEW),
    ('LA36-launch-as-spawned-agent', 'src/main/acces-mobile-routes.ts', "detached: true, defaultKind: 'workspace', origin: 'human' })", "detached: true, defaultKind: 'spawned', origin: 'human' })", 'RED', WIRING),
    ('LA37-launch-picks-a-model', 'src/main/acces-mobile-routes.ts', "dispatchSpawnRequest({ repoPath, task, detached: true,", "dispatchSpawnRequest({ repoPath, task, model: 'opus', detached: true,", 'RED', WIRING),
    ('LA38-repos-route-gone', 'src/main/acces-mobile-routes.ts', "      case '/mobile/repos':", "      case '/mobile/reposX':", 'RED', WIRING),
    ('LA39-launch-sees-no-registered-repos', 'src/main/acces-mobile-routes.ts', "  repos: () => store.repos,", "  repos: () => [],", 'RED', WIRING),
    ('LA41-agent-spawn-can-claim-human', 'src/main/hooks-server.ts', "                  defaultKind: 'spawned',\n                }),", "                  defaultKind: 'spawned',\n                  origin: msg.origin === 'human' ? 'human' : undefined,\n                }),", 'RED', WIRING),
    # the phone's launch screen (launch.ts) + the shell's « + » / #new route (page.ts); launch.test.ts runs the REAL scripts in a vm
    ('LU1-prompt-not-required', 'src/acces-mobile/launch.ts', "      go.disabled = st.busy || !st.sel || !ta.value.trim();", "      go.disabled = st.busy || !st.sel;", 'RED', LAUNCHUI),
    ('LU2-repo-not-required', 'src/acces-mobile/launch.ts', "      go.disabled = st.busy || !st.sel || !ta.value.trim();", "      go.disabled = st.busy || !ta.value.trim();", 'RED', LAUNCHUI),
    ('LU3a-busy-keeps-the-button-live', 'src/acces-mobile/launch.ts', "      go.disabled = st.busy || !st.sel || !ta.value.trim();", "      go.disabled = !st.sel || !ta.value.trim();", 'RED', LAUNCHUI),
    ('LU3b-click-guard-without-busy', 'src/acces-mobile/launch.ts', "      if (st.busy || !st.sel || !prompt) return;", "      if (!st.sel || !prompt) return;", 'EQUIV', LAUNCHUI),  # the disabled button already ignores the tap
    ('LU3c-never-busy', 'src/acces-mobile/launch.ts', "      st.busy = true; root.dataset.state = 'sending'; say(null); sync();", "      root.dataset.state = 'sending'; say(null); sync();", 'RED', LAUNCHUI),
    ('LU6-draft-lost-on-close', 'src/acces-mobile/launch.ts', "      st.draft = ta.value;\n", "", 'RED', LAUNCHUI),
    ('LU7-success-keeps-the-draft', 'src/acces-mobile/launch.ts', "              u.ta.value = ''; root.dataset.state = 'launched'; u.sync();", "              root.dataset.state = 'launched'; u.sync();", 'RED', LAUNCHUI),
    ('LU8-success-does-not-open-the-conversation', 'src/acces-mobile/launch.ts', "            location.hash = 'w=' + encodeURIComponent(res.body.id); // the conversation opens: the agent picks the task up\n", "", 'RED', LAUNCHUI),
    ('LU9-error-not-shown', 'src/acces-mobile/launch.ts', "            root.dataset.state = 'error'; u.say(f); u.sync();", "            root.dataset.state = 'error'; u.sync();", 'RED', LAUNCHUI),
    ('LU10-body-carries-more', 'src/acces-mobile/launch.ts', "body: JSON.stringify({ repoPath: st.sel, prompt: prompt })", "body: JSON.stringify({ repoPath: st.sel, prompt: prompt, model: 'opus' })", 'RED', LAUNCHUI),
    ('LU11-token-in-the-url', 'src/acces-mobile/launch.ts', "fetch('/api/repos', { headers: { Authorization: 'Bearer ' + token() }, cache: 'no-store' })", "fetch('/api/repos?t=' + token(), { headers: { Authorization: 'Bearer ' + token() }, cache: 'no-store' })", 'RED', LAUNCHUI),
    ('LU12-repo-name-as-markup', 'src/acces-mobile/launch.ts', "rn.appendChild(el('b', null, r.name));", "var bb = el('b'); bb.innerHTML = r.name; rn.appendChild(bb);", 'RED', LAUNCHUI),
    ('LU13-unpaired-still-fetches', 'src/acces-mobile/launch.ts', "    if (!token()) { location.hash = ''; return; } // unpaired: the list shows the pairing panel\n", "", 'RED', LAUNCHUI),
    ('LU14-refused-token-no-repair', 'src/acces-mobile/launch.ts', "          if (f.repair) { location.hash = ''; }\n", "", 'RED', LAUNCHUI),
    ('LU15-start-failure-offers-nothing', 'src/shared/acces-mobile-launch.ts', "return typeof b.id === 'string' && b.id ? { text, open: b.id } : { text };", "return { text };", 'RED', SHLAUNCH),
    ('LU16-lost-reply-claims-nothing-created', 'src/shared/acces-mobile-launch.ts', "if (status === null) return { text: 'Réseau coupé : le workspace est peut-être créé. ' + lost };", "if (status === null) return { text: 'Réseau coupé : aucun workspace n’a été créé.' };", 'RED', SHLAUNCH),
    ('LU17-bad-gateway-claims-nothing-created', 'src/shared/acces-mobile-launch.ts', "if (status >= 500) return { text: 'Orchestra injoignable : le workspace est peut-être créé. ' + lost };", "if (status >= 500) return { text: 'Orchestra injoignable : aucun workspace n’a été créé.' };", 'RED', SHLAUNCH),
    ('LU20-no-new-route', 'src/acces-mobile/page.ts', "    } else if (location.hash === '#new' && launch) {", "    } else if (false) {", 'RED', LAUNCHUI),
    ('LU21-plus-button-dead', 'src/acces-mobile/page.ts', "  document.getElementById('newBtn').addEventListener('click', function () { location.hash = 'new'; });", "", 'RED', LAUNCHUI),
    ('LU22-launch-meta-ignored', 'src/acces-mobile/page.ts', " || (launch && launch.meta(m2[1]));", ";", 'RED', LAUNCHUI),
    ('LU23-launch-never-closed', 'src/acces-mobile/page.ts', "    else { conv.close(); if (launch) launch.close(); home.hidden = false; load(); }", "    else { conv.close(); home.hidden = false; load(); }", 'RED', LAUNCHUI),
    ('LU24-list-not-hidden-behind-the-form', 'src/acces-mobile/page.ts', "conv.close(); home.hidden = true; launch.open(); }", "conv.close(); launch.open(); }", 'RED', LAUNCHUI),
    ('LU25-launch-js-not-served', 'src/acces-mobile/server.ts', "  '/launch.js': { type: 'text/javascript; charset=utf-8', body: LAUNCH_JS },\n", "", 'RED', SLAUNCH),
    ('LU26-launch-css-not-served', 'src/acces-mobile/server.ts', "  '/launch.css': { type: 'text/css; charset=utf-8', body: LAUNCH_CSS },\n", "", 'RED', SLAUNCH),
    ('LU27-launch-not-in-offline-shell', 'src/acces-mobile/sw.ts', "'/launch.js', '/launch.css', '/manifest.webmanifest'", "'/manifest.webmanifest'", 'RED', PWA),
    ('LA42-start-error-not-carried', 'src/main/workspaces.ts', "    startError: cause,\n", "", 'RED', WIRING),
    ('LA43-throw-after-create-drops-the-id', 'src/main/workspaces.ts', "return created ? keptFailure(created.id, created.branch, msg) : { ok: false, error: msg };", "return { ok: false, error: msg };", 'RED', WIRING),
    ('LU28-reopen-while-busy-shows-a-live-button', 'src/acces-mobile/launch.ts', "      go.disabled = st.busy || !st.sel || !ta.value.trim();", "      go.disabled = !st.sel || !ta.value.trim();", 'RED', LAUNCHUI),
    ('LU29-answer-while-away-hijacks-the-page', 'src/acces-mobile/launch.ts', "            if (u) {\n              u.ta.value = '';", "            {\n              u = u || st.ui || { ta: { value: '' }, sync() {} };\n              u.ta.value = '';", 'RED', LAUNCHUI),
    ('LU30-kept-workspace-keeps-the-draft', 'src/acces-mobile/launch.ts', "            if (f.open) u.ta.value = '';\n", "", 'RED', LAUNCHUI),
    ('LU31-kept-workspace-unknown-to-the-header', 'src/acces-mobile/launch.ts', "          if (f.open) { st.launched = made({ id: f.open, branch: res.body && res.body.branch }); st.draft = ''; }", "          if (f.open) { st.draft = ''; }", 'RED', LAUNCHUI),
    ('LU32-repos-401-not-repaired', 'src/acces-mobile/launch.ts', "if (r.status === 401) { location.hash = ''; return null; } return r.ok", "if (false) { location.hash = ''; return null; } return r.ok", 'RED', LAUNCHUI),
    ('LU33-pick-while-busy', 'src/acces-mobile/launch.ts', "          if (st.busy) return; // the launch in flight is for THIS repo\n", "", 'RED', LAUNCHUI),
    ('LU34-late-failure-lost', 'src/acces-mobile/launch.ts', "          st.error = f;\n          if (u) {", "          if (u) {", 'RED', LAUNCHUI),
    ('LU35-gateway-5xx-claims-nothing-created', 'src/shared/acces-mobile-launch.ts', "  if (status >= 500) return { text: 'Orchestra injoignable : le workspace est peut-être créé. ' + lost };", "  if (status === 502) return { text: 'Orchestra injoignable : le workspace est peut-être créé. ' + lost };", 'RED', SHLAUNCH),
    # conversation.js fetchConv: a refresh timer firing after the conversation was closed poisoned the screen (found by the #375 rig)
    # the feed core: an EMPTY history (transcript not on disk yet) is re-read, bounded, with a changed version (#375)
    ('CV1-refresh-fires-for-a-closed-conversation', 'src/acces-mobile/conversation.ts', '      if (!id) { inflight = false; again = false; return; }\n', '', 'RED', CLOSERACE),
    ('CV3-queued-refresh-survives-the-close', 'src/acces-mobile/conversation.ts', '      if (!id) { inflight = false; again = false; return; }\n', '      if (!id) { inflight = false; return; }\n', 'RED', CLOSERACE),
    ('CV4-abandoned-refresh-moves-the-throttle-clock', 'src/acces-mobile/conversation.ts', '      if (!id) { inflight = false; again = false; return; }\n      lastFetch = Date.now();\n', '      lastFetch = Date.now();\n      if (!id) { inflight = false; again = false; return; }\n', 'RED', CLOSERACE),
    ('CV5-stale-success-draws-into-the-next-conversation', 'src/acces-mobile/conversation.ts', "          if (id !== current) return;\n          var stEl = root.querySelector('.conv-state');\n          if (c && c.ok)", "          var stEl = root.querySelector('.conv-state');\n          if (c && c.ok)", 'RED', CLOSERACE),
    ('CV6-late-failure-paints-the-next-conversation', 'src/acces-mobile/conversation.ts', '.catch(function () { if (id !== current) return; var stEl', '.catch(function () { var stEl', 'RED', CLOSERACE),
    ('FH1-empty-history-trusted', 'src/main/acces-mobile-feed-core.ts', '  e.suspect = lagging || e.session.messages.length === 0;\n  if (e.suspect) scheduleEmptyHeal(id, e);\n  else e.emptyRetries = 0;\n', '  e.suspect = false;\n  e.emptyRetries = 0;\n', 'RED', FEEDCORE),
    ('FH2-heal-announces-the-same-version', 'src/main/acces-mobile-feed-core.ts', '    e.version++; // a CHANGED version: the phone only refetches on a version it does not have\n', '', 'RED', FEEDCORE),
    ('FH3-heal-unbounded', 'src/main/acces-mobile-feed-core.ts', 'if (e.emptyTimer || e.emptyRetries >= EMPTY_RETRY_MAX) return;', 'if (e.emptyTimer) return;', 'EQUIV', FEEDCORE),  # the retry budget is also checked at the read-time reload and on reloadPending: the timer's own check is the third guard
    ('FH5-dropped-entry-keeps-its-timer', 'src/main/acces-mobile-feed-core.ts', '  if (e?.emptyTimer) clearTimeout(e.emptyTimer);\n', '', 'RED', FEEDCORE),
    ('FH6-empty-conversation-never-re-read', 'src/main/acces-mobile-feed-core.ts', '(e.reloadPending || (e.suspect && e.session.messages.length === 0 && e.emptyRetries < EMPTY_RETRY_MAX))', '(e.reloadPending)', 'RED', FEEDCORE),
    ('FH7-lagging-disk-replaces-the-live-fold', 'src/main/acces-mobile-feed-core.ts', '  const lagging = e.suspect && next.messages.length < e.session.messages.length;\n', '  const lagging = false;\n', 'RED', FEEDCORE),
    ('FH8-turn-end-does-not-re-read-a-suspect-entry', 'src/main/acces-mobile-feed-core.ts', '(e.missedWhileLoading || e.suspect)) e.reloadPending = true;', '(e.missedWhileLoading)) e.reloadPending = true;', 'RED', FEEDCORE),
    ('FH9-retry-timer-never-clears', 'src/main/acces-mobile-feed-core.ts', '    e.emptyTimer = null;\n    e.emptyRetries++;', '    e.emptyRetries++;', 'RED', FEEDCORE),
    ('FH10-retry-budget-one', 'src/main/acces-mobile-feed-core.ts', 'export const EMPTY_RETRY_MAX = 5;', 'export const EMPTY_RETRY_MAX = 1;', 'RED', FEEDCORE),
    ('FH11-re-read-mid-turn', 'src/main/acces-mobile-feed-core.ts', 'if (!e.loading && !running(id, e) && (e.reloadPending ||', 'if (!e.loading && (e.reloadPending ||', 'RED', FEEDCORE),
    ('FH12-rejected-re-read-retries-forever', 'src/main/acces-mobile-feed-core.ts', '  e.reloadPending = lagging && e.emptyRetries < EMPTY_RETRY_MAX;\n', '  e.reloadPending = lagging;\n', 'RED', FEEDCORE),
    ('LA40-launch-unattended-by-main', 'src/main/acces-mobile-routes.ts', "        return launcher.launch(msg);", "        return { ok: true };", 'RED', WIRING),
    ('W2-refused-stream-not-told', 'src/acces-mobile/page.ts', "    if (m.t === 'down') { live(false); if (m.status === 401) load(); return; }", "    if (m.t === 'down') { live(false); return; }", 'RED', PWA),
    # ── 2026-10-12 (#374): the phone and the desktop share ONE tool line (src/shared/tool-line.ts) ──
    ('T1-phone-tool-line-own-label', 'src/shared/acces-mobile-conversation.ts', "return { id: m.id, kind: 'tool', ...toolLine(m), at };", "return { id: m.id, kind: 'tool', label: m.toolUse.name, state: 'ok', at };", 'RED', 'src/shared/acces-mobile-conversation.test.ts'),
    ('T2-phone-glyph-map-forked', 'src/acces-mobile/conversation.ts', "var STATE = ${JSON.stringify(TOOL_GLYPH)};", 'var STATE = {"running":"…","ok":"✓","error":"✓"};', 'RED', 'src/shared/tool-line.test.ts'),
    # ── 2026-10-12 wave I (#373): the whole agent tree on the phone ──
    ('L1-direct-parent-only', 'src/shared/acces-mobile.ts', "      cur = byId.get(cur)?.parentId;\n", "      cur = undefined;\n", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('L2-archived-parent-is-listed', 'src/shared/acces-mobile.ts', "      if (listed.has(cur)) { answer = cur; break; }\n", "      if (byId.has(cur)) { answer = cur; break; }\n", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('L3-row-is-its-own-ancestor', 'src/shared/acces-mobile.ts', "    return a === ws.id ? undefined : a;\n", "    return a;\n", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('L4-parent-not-projected', 'src/shared/acces-mobile.ts', "    if (parentId) row.parentId = parentId;\n", "", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('TT1-cycle-rows-dropped', 'src/shared/acces-mobile-tree.ts', "    walk(x);\n  }\n  roots.sort(", "  }\n  roots.sort(", 'RED', TREE),
    ('TT2-roots-not-in-input-order', 'src/shared/acces-mobile-tree.ts', "  roots.sort(function (a, b) { return a - b; });\n", "", 'RED', TREE),
    ('TT3-stand-in-without-anyone-below', 'src/shared/acces-mobile-tree.ts', "    if (waiting && !kids.length) continue; // leaves nodes[x] undefined\n", "", 'RED', TREE),
    ('TT4-waiting-row-kept-as-a-row', 'src/shared/acces-mobile-tree.ts', "standIn: waiting,", "standIn: false,", 'RED', TREE),
    ('TT5-stand-in-counted-as-an-agent', 'src/shared/acces-mobile-tree.ts', "if (!child.standIn) { agents += 1;", "if (true) { agents += 1;", 'RED', TREE),
    ('TT6-agents-direct-kids-only', 'src/shared/acces-mobile-tree.ts', "agents += child.agents; running += child.running; unread += child.unread;", "running += child.running; unread += child.unread;", 'RED', TREE),
    ('TT7-running-direct-kids-only', 'src/shared/acces-mobile-tree.ts', "agents += child.agents; running += child.running; unread += child.unread;", "agents += child.agents; unread += child.unread;", 'RED', TREE),
    ('TT8-unread-direct-kids-only', 'src/shared/acces-mobile-tree.ts', "agents += child.agents; running += child.running; unread += child.unread;", "agents += child.agents; running += child.running;", 'RED', TREE),
    ('TT9-running-not-counted', 'src/shared/acces-mobile-tree.ts', "if (child.row.status === 'running') running += 1; ", "", 'RED', TREE),
    ('TT10-unread-not-counted', 'src/shared/acces-mobile-tree.ts', "if (child.row.unread) unread += 1; ", "", 'RED', TREE),
    ('TT11-waiting-only-at-the-top', 'src/shared/acces-mobile-tree.ts', "if (rows[i].status === 'waiting') out.waiting.push(rows[i]);", "if (rows[i].status === 'waiting' && parentOf[i] < 0) out.waiting.push(rows[i]);", 'RED', TREE),
    ('TT12-section-count-roots-only', 'src/shared/acces-mobile-tree.ts', "g.count += (node.standIn ? 0 : 1) + node.agents;", "g.count += (node.standIn ? 0 : 1);", 'RED', TREE),
    ('TT13-section-counts-the-stand-in', 'src/shared/acces-mobile-tree.ts', "g.count += (node.standIn ? 0 : 1) + node.agents;", "g.count += 1 + node.agents;", 'RED', TREE),
    ('TT14-sections-reversed', 'src/shared/acces-mobile-tree.ts', "out.groups.push(g);", "out.groups.unshift(g);", 'RED', TREE),
    ('TT15-siblings-reversed', 'src/shared/acces-mobile-tree.ts', "if (p !== undefined && p !== i) kidsOf[p].push(i);", "if (p !== undefined && p !== i) kidsOf[p].unshift(i);", 'RED', TREE),
    ('TT16-depth-flat', 'src/shared/acces-mobile-tree.ts', "depth[kid] = depth[cur] + 1;", "depth[kid] = 1;", 'RED', TREE),
    # ── #373-fu (review R373-1 / R373-2): the layout geometry and the memoised ancestor walk ──
    ('L5-memo-not-read', 'src/shared/acces-mobile.ts', "      if (resolved.has(cur)) { answer = resolved.get(cur); break; }\n", "", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('L6-memo-not-filled', 'src/shared/acces-mobile.ts', "    for (const id of path) resolved.set(id, answer);\n", "", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('L7-no-loop-guard', 'src/shared/acces-mobile.ts', "      if (onPath.has(cur)) break;\n", "", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('L8-negative-answer-not-memoised', 'src/shared/acces-mobile.ts', "    for (const id of path) resolved.set(id, answer);\n", "    if (answer !== undefined) for (const id of path) resolved.set(id, answer);\n", 'RED', 'src/shared/acces-mobile.test.ts'),
    ('CSS13-row-padding-moves-the-root-glyph', CV, "padding:12px 20px;border-bottom:1px solid var(--hairf);cursor:pointer}", "padding:12px 24px;border-bottom:1px solid var(--hairf);cursor:pointer}", 'RED', CSS),
    ('CSS14-small-row-padding-moves-the-root-glyph', CV, ".v1 .row.small{padding:10px 20px}", ".v1 .row.small{padding:10px 24px}", 'RED', CSS),
    ('CSS15-stand-in-glyph-column-wider', CV, ".v1 .so-g{width:22px;", ".v1 .so-g{width:26px;", 'RED', CSS),
    ('CSS1-clamp-removed', CV, "--d:min(var(--depth),8);", "--d:var(--depth);", 'RED', CSS),
    ('CSS2-clamp-too-early', CV, "--d:min(var(--depth),8);", "--d:min(var(--depth),3);", 'RED', CSS),
    ('CSS3-step-not-16', CV, "--ind:calc(20px + var(--d)*16px)", "--ind:calc(20px + var(--d)*14px)", 'RED', CSS),
    ('CSS4-rail-size-unclamped', CV, "background-size:calc(var(--d)*16px) 100%", "background-size:calc(var(--depth)*16px) 100%", 'RED', CSS),
    ('CSS5-rail-off-by-one-px', CV, "transparent 0 15px,var(--hair2) 15px 16px", "transparent 0 14px,var(--hair2) 14px 15px", 'RED', CSS),
    ('CSS6-fold-line-not-indented', CV, "padding:8px 20px 8px calc(var(--ind,20px) + 34px)", "padding:8px 20px 8px 54px", 'RED', CSS),
    ('CSS7-fold-text-not-under-the-title', CV, "padding:8px 20px 8px calc(var(--ind,20px) + 34px)", "padding:8px 20px 8px calc(var(--ind,20px) + 30px)", 'RED', CSS),
    ('CSS8-stand-in-not-indented', CV, ".v1 .fold-owner.stand{display:flex;align-items:center;gap:12px;padding-left:var(--ind)}", ".v1 .fold-owner.stand{display:flex;align-items:center;gap:12px}", 'RED', CSS),
    ('CSS9-nested-row-not-indented', CV, ".v1 .row.child{padding-left:var(--ind);", ".v1 .row.child{padding-left:42px;", 'RED', CSS),
    ('CSS10-no-rail-on-fold-lines', CV, ".v1 .row.child,.v1 .fold[data-depth],.v1 .fold-owner.stand{background-image", ".v1 .row.child,.v1 .fold-owner.stand{background-image", 'RED', CSS),
    ('CSS11-no-rail-on-stand-in', CV, ".v1 .row.child,.v1 .fold[data-depth],.v1 .fold-owner.stand{background-image", ".v1 .row.child,.v1 .fold[data-depth]{background-image", 'RED', CSS),
    ('CSS12-rail-anchored-wrong', CV, "background-repeat:no-repeat;background-position:16px 0;", "background-repeat:no-repeat;background-position:20px 0;", 'RED', CSS),
    ('TT33-cycle-walked-from-the-first-row-not-its-entry', 'src/shared/acces-mobile-tree.ts', "    walk(x);\n  }\n  roots.sort(", "    walk(i);\n  }\n  roots.sort(", 'RED', TREE),
    ('TT19-fold-counts-direct-kids', 'src/acces-mobile/page.ts', "li.appendChild(el('span', 'fold-n', n.agents + ' agent' + (n.agents > 1 ? 's' : '')));", "li.appendChild(el('span', 'fold-n', n.kids.length + ' agent' + (n.kids.length > 1 ? 's' : '')));", 'RED', PL),
    ('TT20-fold-running-not-shown', 'src/acces-mobile/page.ts', "    if (n.running) li.appendChild(el('span', 'fold-run', n.running + ' en cours'));\n", "", 'RED', PL),
    ('TT21-fold-unread-not-shown', 'src/acces-mobile/page.ts', "    if (n.unread) li.appendChild(el('span', 'fold-unread', n.unread + ' non lu' + (n.unread > 1 ? 's' : '')));\n", "", 'RED', PL),
    ('TT22-open-state-reset-on-redraw', 'src/acces-mobile/page.ts', "    listEl.textContent = '';\n    var rows = needsMe.checked ? me : last;", "    listEl.textContent = ''; open = Object.create(null);\n    var rows = needsMe.checked ? me : last;", 'RED', PL),
    ('TT34-open-state-reset-on-refresh', 'src/acces-mobile/page.ts', "        last = j.workspaces; render();", "        last = j.workspaces; open = Object.create(null); render();", 'RED', PL),
    ('TT23-folds-share-one-state', 'src/acces-mobile/page.ts', "    li.addEventListener('click', function () { open[id] = !open[id]; render(); });\n    return li;\n  }\n  /** An en attente coordinator", "    li.addEventListener('click', function () { var v = !open[id]; open = Object.create(null); open[id] = v; render(); });\n    return li;\n  }\n  /** An en attente coordinator", 'RED', PL),
    ('TT24-kids-not-drawn-when-open', 'src/acces-mobile/page.ts', "    if (open[n.row.id]) n.kids.forEach(function (k) { drawNode(ul, k); });", "    if (open[n.row.id] && !n.depth) n.kids.forEach(function (k) { drawNode(ul, k); });", 'RED', PL),
    ('TT25-no-indent-depth', 'src/acces-mobile/page.ts', "li.dataset.depth = String(depth); li.style.setProperty('--depth', String(depth)); return li; }", "li.dataset.depth = String(depth); li.style.setProperty('--depth', '1'); return li; }", 'RED', PL),
    ('TT26-stand-in-not-drawn', 'src/acces-mobile/page.ts', "    ul.appendChild(n.standIn ? standIn(n) : row(n.row, false, n.depth));", "    if (!n.standIn) ul.appendChild(row(n.row, false, n.depth));", 'RED', PL),
    ('TT27-stand-in-fold-missing', 'src/acces-mobile/page.ts', "    if (!n.kids.length) return;\n    ul.appendChild(fold(n));", "    if (!n.kids.length || n.standIn) return;\n    ul.appendChild(fold(n));", 'RED', PL),
    ('TT28-waiting-row-also-in-the-tree', 'src/acces-mobile/page.ts', "    buildTree(last).groups.forEach(function (g) {", "    buildTree(last.map(function (w) { return w.status === 'waiting' ? Object.assign({}, w, { status: 'idle' }) : w; })).groups.forEach(function (g) {", 'RED', PL),
    ('TT29-section-count-direct-rows', 'src/acces-mobile/page.ts', "      listEl.appendChild(section('rh', g.group, g.count));", "      listEl.appendChild(section('rh', g.group, g.roots.length));", 'RED', PL),
    ('TT30-tree-not-used-for-the-list', 'src/acces-mobile/page.ts', "    buildTree(last).groups.forEach(function (g) {", "    buildTree(last.map(function (w) { return Object.assign({}, w, { parentId: undefined }); })).groups.forEach(function (g) {", 'RED', PL),
    ('TT32-a-fold-never-closes', 'src/acces-mobile/page.ts', "    li.addEventListener('click', function () { open[id] = !open[id]; render(); });", "    li.addEventListener('click', function () { open[id] = true; render(); });", 'RED', PL),
    # EQUIVALENT (documented): a self-parent is also handled by the cycle pass (the row is its own kid, seen ⇒ skipped) — the explicit guards are belt and braces
    ('TT17-self-parent-guards-removed', 'src/shared/acces-mobile-tree.ts', "    parentOf.push(p !== undefined && p !== i ? p : -1);\n    if (p !== undefined && p !== i) kidsOf[p].push(i);", "    parentOf.push(p !== undefined ? p : -1);\n    if (p !== undefined) kidsOf[p].push(i);", 'EQUIV', TREE),
    # EQUIVALENT (documented, reviewer R373): differs only WITH duplicate ids, which cannot exist (store.ts upserts by id, ids are randomUUID())
    ('TT18-last-duplicate-wins', 'src/shared/acces-mobile-tree.ts', "if (first[rows[i].id] === undefined) first[rows[i].id] = i;", "first[rows[i].id] = i;", 'EQUIV', TREE),
]

E2E = '--e2e' in sys.argv[1:]
ONLY = [a for a in sys.argv[1:] if a != '--e2e']

# Built-app mutants (#336): each must turn at least one e2e clause red (or abort the drive) on the REAL built app.
E2E_MUTANTS = [
    # (id, file, original, replacement, the clause (prefix) expected to go red)
    ('E1-qr-encodes-fragment-only', 'src/renderer/components/AccesMobileSettings.tsx', "<AccesMobileQr text={view.pairingUrl} />", "<AccesMobileQr text={view.pairingFragment ?? ''} />", 'qr/rendered-pixels-decode-to-url'),
    ('E2-regenerate-never-lands', 'src/main/acces-mobile-token.ts', "  fs.renameSync(tmp, tokenFileIn(dir));\n", "", 'regen/'),
    ('E3-sw-caches-api', 'src/acces-mobile/sw.ts', "    if (url.pathname.indexOf('/api/') === 0) return; // data (and the token that unlocks it) never goes through the cache\n    var isNav = req.mode === 'navigate';\n    if (isNav ? url.pathname !== '/' : SHELL.indexOf(url.pathname) < 0) return;\n", "    var isNav = req.mode === 'navigate';\n", 'pwa/service-worker-shell-only-cache'),
    ('E4-icons-before-identity', 'src/acces-mobile/server.ts', "    const login = req.headers['tailscale-user-login'];\n", "    const png0 = STATIC[pathOnly]; if (png0 && png0.type === 'image/png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png0.body); return; }\n    const login = req.headers['tailscale-user-login'];\n", 'sec/assets-need-identity'),
    ('E5-sw-no-fallback-on-502', 'src/acces-mobile/sw.ts', "      if (res.status >= 500) return fromCache", "      if (res.status >= 600) return fromCache", 'pwa/unreachable-server-off-served-from-cache'),
    ('E6-regenerate-logs-token', 'src/main/acces-mobile-host.ts', "  generateAccesMobileToken();\n  log.info('pairing token regenerated — the previous token is refused from now on');", "  const t = generateAccesMobileToken();\n  log.info(`pairing token regenerated ${t}`);", 'leak/no-token-in-logs-or-files'),
    ('E7-page-ignores-hashchange', 'src/acces-mobile/page.ts', "    if (pairFromHash()) {\n      try { token = localStorage.getItem(KEY); } catch (e) {}\n      conv.connect();\n      route();\n      return;\n    }\n", "", 'regen/repair-with-new-url'),
    ('E8-unread-counts-as-a-traiter', 'src/acces-mobile/page.ts', "  function needs(w) { return w.status === 'waiting'; }", "  function needs(w) { return w.status === 'waiting' || w.unread; }", 'phone/list'),
    ('E9-workers-not-folded', 'src/acces-mobile/page.ts', "    buildTree(last).groups.forEach(function (g) {", "    buildTree(last.map(function (w) { return Object.assign({}, w, { parentId: undefined }); })).groups.forEach(function (g) {", 'phone/list'),
    ('E10-markdown-shown-raw', 'src/acces-mobile/conversation.ts', "row.appendChild(md(l.text)); }", "row.textContent = l.text; }", 'conv/markdown'),
    ('E11-opens-at-the-top', 'src/acces-mobile/conversation.ts', "    if (nearBottom || version < 0) se.scrollTop", "    if (nearBottom && version >= 0) se.scrollTop", 'conv/opens-at-end'),
    ('E12-fold-hides-a-waiting-worker', 'src/acces-mobile/page.ts', "    var waiting = rows.filter(needs);", "    var waiting = rows.filter(function (w) { return needs(w) && !w.parentId; });", 'phone/folded-worker-waiting-surfaces'),
    ('E13-photo-not-scaled', 'src/acces-mobile/conversation.ts', "IMG_EDGE = 1568;", "IMG_EDGE = 100000;", 'attach/reach-the-model'),
    ('E14-main-drops-files', 'src/main/acces-mobile-routes.ts', "await sdkSend(ws.id, text, atts.images.length ? atts.images : undefined,", "await sdkSend(ws.id, text, undefined,", 'attach/'),
    ('E15-paste-ignored', 'src/acces-mobile/conversation.ts', "      if (!cd.getData('text/plain')) ev.preventDefault();\n      addFiles(files);\n", "", 'attach/pick-paste-remove'),
    ('E16-scan-never-pairs', 'src/acces-mobile/page.ts', "          stopScan(); adopt(tok);", "          stopScan();", 'pair/in-app-scan'),
    ('E17-camera-left-on', 'src/acces-mobile/page.ts', "          stopScan(); adopt(tok);", "          adopt(tok);", 'pair/in-app-scan'),
    ('E18-decoder-not-inlined', 'vite.acces-mobile.config.ts', "if (!id.endsWith('/src/acces-mobile/jsqr-src.ts')) return null;", "if (!id.endsWith('/nothing-matches.ts')) return null;", 'pair/'),
    ('E19-header-sticks-under-status-bar', 'src/acces-mobile/conversation.ts', ".v1 .ch{position:sticky;top:env(safe-area-inset-top);z-index:2;", ".v1 .ch{position:sticky;top:0;z-index:2;", 'conv/header-below-status-bar'),
    ('E20-status-bar-strip-gone', 'src/acces-mobile/conversation.ts', "body.v1::before{content:", "body.v1::after{content:", 'conv/header-below-status-bar'),
    ('E21-later-ignored', 'src/renderer/components/AppUpdateBanner.tsx', "          dismissedKey = key;\n", "", 'update/later-until-next-install'),
    ('E22-relaunch-without-waiting', 'src/shared/app-update.ts', "while kill -0 \"$1\" 2>/dev/null && [ \"$i\" -lt 600 ]; do", "while false; do", 'update/relaunch'),
    ('E24-conversation-title-full-name', 'src/acces-mobile/conversation.ts', "meta.displayName || meta.name || id", "meta.name || id", 'conv/title-no-repo-prefix'),
    ('E25-list-renders-the-full-name', 'src/acces-mobile/page.ts', "r1.appendChild(el('b', null, w.displayName || w.name));", "r1.appendChild(el('b', null, w.name));", 'phone/no-repo-prefix'),
    ('E26-waiting-row-without-repo-chip', 'src/acces-mobile/page.ts', "    if (withRepo) r2.appendChild(el('span', 'repo', w.group));\n", "", 'phone/waiting-row-keeps-repo-chip'),
    ('E27-projection-without-displayName', 'src/shared/acces-mobile.ts', "      displayName: mobileDisplayName(ws),\n", "      displayName: ws.name,\n", 'phone/no-repo-prefix'),
    ('E23-phone-not-told', 'src/main/acces-mobile-routes.ts', "          ...(update.kind === 'installed' ? { appUpdate: { version: update.version } } : {}),\n", "", 'update/phone-banner'),
    # ── 2026-10-12 wave I (#373): the whole agent tree ──
    ('E28-indent-css-gone', 'src/acces-mobile/conversation.ts', ".v1 .row.child{padding-left:var(--ind);background-color:rgba(255,255,255,.015)}", ".v1 .row.child{padding-left:42px;background-color:rgba(255,255,255,.015)}", 'phone/tree-indent-one-step-per-level'),
    ('E29-fold-counts-direct-kids', 'src/acces-mobile/page.ts', "li.appendChild(el('span', 'fold-n', n.agents + ' agent' + (n.agents > 1 ? 's' : '')));", "li.appendChild(el('span', 'fold-n', n.kids.length + ' agent' + (n.kids.length > 1 ? 's' : '')));", 'phone/tree-fold-counts-whole-subtree'),
    ('E30-open-state-reset-on-refresh', 'src/acces-mobile/page.ts', "        last = j.workspaces; render();", "        last = j.workspaces; open = Object.create(null); render();", 'phone/tree-open-state-survives-refresh'),
    ('E31-stand-in-not-drawn', 'src/acces-mobile/page.ts', "    ul.appendChild(n.standIn ? standIn(n) : row(n.row, false, n.depth));", "    if (!n.standIn) ul.appendChild(row(n.row, false, n.depth));", 'phone/tree-waiting-ancestor-stand-in'),
    ('E32-only-first-level-drawn', 'src/acces-mobile/page.ts', "    if (open[n.row.id]) n.kids.forEach(function (k) { drawNode(ul, k); });", "    if (open[n.row.id] && !n.depth) n.kids.forEach(function (k) { drawNode(ul, k); });", 'phone/tree-every-row-reachable'),
    ('E33-archived-parent-not-walked', 'src/shared/acces-mobile.ts', "      cur = byId.get(cur)?.parentId;\n", "      cur = undefined;\n", 'phone/tree-fold-counts-whole-subtree'), # the row still shows (as a root): it is the PLACEMENT and the counts that break
    # ── #373-fu: the layout contract in real Chromium ──
    ('E34-clamp-removed', 'src/acces-mobile/conversation.ts', "--d:min(var(--depth),8);", "--d:var(--depth);", 'phone/tree-css-geometry'),
    ('E35-fold-line-not-indented', 'src/acces-mobile/conversation.ts', "padding:8px 20px 8px calc(var(--ind,20px) + 34px)", "padding:8px 20px 8px 54px", 'phone/tree-css-geometry'),
    ('E36-rail-gone-from-rows', 'src/acces-mobile/conversation.ts', ".v1 .row.child,.v1 .fold[data-depth],.v1 .fold-owner.stand{background-image", ".v1 .fold[data-depth],.v1 .fold-owner.stand{background-image", 'phone/tree-css-geometry'),
    ('E37-rail-size-unclamped', 'src/acces-mobile/conversation.ts', "background-size:calc(var(--d)*16px) 100%", "background-size:calc(var(--depth)*16px) 100%", 'phone/tree-css-geometry'),
    ('E50-launch-takes-the-spawned-kind', 'src/main/acces-mobile-routes.ts', "detached: true, defaultKind: 'workspace', origin: 'human' })", "detached: true, defaultKind: 'spawned', origin: 'human' })", 'launch/repos-compte-and-workspace-defaults'),
    ('E51-unregistered-repo-not-refused-by-the-launcher', 'src/main/acces-mobile-launch.ts', "      if (!deps.repos().some((r) => r.path === repoPath)) return Promise.resolve({ ok: false, code: 'unknown-repo', error: 'unknown repo' });\n", '', 'launch/unregistered-repo-refused'),
    ('E52-launch-route-on-the-hooks-socket', 'src/main/hooks-server.ts', "          } else if (route === '/accounts') {", "          } else if (route === '/mobile/launch') { send(200, { ok: true, leaked: true });\n          } else if (route === '/accounts') {", 'launch/hooks-socket-has-no-launch-route'),
    ('E53-launch-loses-the-prompt', 'src/main/acces-mobile-launch.ts', 'res = await deps.spawn({ repoPath, task: prompt });', "res = await deps.spawn({ repoPath, task: 'ignore le prompt du telephone' });", 'launch/creates-workspace'),
    ('E54-prompt-optional-on-the-phone', 'src/acces-mobile/launch.ts', '      go.disabled = st.busy || !st.sel || !ta.value.trim();', '      go.disabled = st.busy || !st.sel;', 'launch/phone-prompt-and-repo-required'),
    ('E55-plus-button-dead', 'src/acces-mobile/page.ts', "  document.getElementById('newBtn').addEventListener('click', function () { location.hash = 'new'; });", '', 'launch/phone-form-lists-repos-with-compte'),
]

def run_e2e(ids):
    base = os.environ.get('ACCES_MOBILE_E2E_SCRATCH') or os.path.expanduser('~/.cache/acces-mobile-e2e-mutants')
    os.makedirs(base, exist_ok=True)
    bad = 0
    for mid, rel, old, new, clause in [m for m in E2E_MUTANTS if not ids or any(m[0].startswith(i) for i in ids)]:
        work = os.path.join(base, mid)
        subprocess.run(['rsync', '-a', '--delete', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'dist', '--exclude', 'dist-electron', '--exclude', 'release', '--exclude', 'shots', ROOT + '/', work + '/'], check=True)
        if not os.path.lexists(os.path.join(work, 'node_modules')): os.symlink(os.path.join(ROOT, 'node_modules'), os.path.join(work, 'node_modules'))
        path = os.path.join(work, rel); src = open(path).read()
        if src.count(old) != 1: print(f'{mid}: ANCHOR NOT FOUND (count={src.count(old)})'); bad += 1; continue
        open(path, 'w').write(src.replace(old, new))
        b = subprocess.run('pnpm run build:bundles', shell=True, cwd=work, capture_output=True, text=True, timeout=600)
        if b.returncode != 0: print(f'{mid}: BUILD FAILED\n{b.stdout[-800:]}{b.stderr[-800:]}'); bad += 1; continue
        env = dict(os.environ)
        r = subprocess.run(['bash', os.path.join(work, 'scripts/e2e-acces-mobile.sh'), work, '--out', os.path.join(work, 'shots')], cwd=work, env=env, capture_output=True, text=True, timeout=900)
        out = r.stdout
        fails = [l.split('—')[0].strip()[6:] for l in out.splitlines() if l.startswith('  FAIL')]
        errored = [l for l in out.splitlines() if l.startswith('ERROR:')]
        passes = sum(1 for l in out.splitlines() if l.startswith('  PASS'))
        hit = any(f.startswith(clause) for f in fails) or any(clause.rstrip('/') in l or True for l in errored[:0])
        if passes + len(fails) == 0:  # not one clause ran: the rig refused / crashed — that is a broken instrument, never a verdict
            print(f'{mid}: INSTRUMENT BROKEN — no clause ran. rig output tail: {out[-600:]!r} stderr: {r.stderr[-300:]!r}'); bad += 1; continue
        red = bool(fails or errored)
        ok = red and (hit or bool(errored))
        print(f'{mid}: {"RED" if red else "GREEN"} on {fails or [e[:120] for e in errored[:1]]} (expected {clause}; {passes} clauses passed) {"OK" if ok else "SURVIVED"}')
        if not ok: bad += 1
    print('E2E CLEAN' if bad == 0 else f'E2E DIRTY ({bad})')
    sys.exit(1 if bad else 0)

if E2E: run_e2e(ONLY)
MUTANTS = [m for m in MUTANTS if not ONLY or any(m[0].startswith(p) for p in ONLY)]
if not MUTANTS: print('no mutant matches', ONLY); sys.exit(2)
bad = 0
for m in MUTANTS:
    mid, rel, old, new, expected = m[:5]
    test = m[5] if len(m) > 5 else TEST
    path = os.path.join(ROOT, rel)
    backup = path + '.mutant-backup'
    src = open(path).read()
    if src.count(old) != 1:
        print(f'{mid}: ANCHOR NOT FOUND (count={src.count(old)}) — instrument broken'); bad += 1; continue
    shutil.copy2(path, backup)
    try:
        open(path, 'w').write(src.replace(old, new))
        try:
            r = subprocess.run(['node', '--test', '--experimental-strip-types', test], cwd=ROOT, capture_output=True, text=True, timeout=180)
            fails = [l for l in r.stdout.splitlines() if l.startswith('# fail ')]
            red = r.returncode != 0
        except subprocess.TimeoutExpired:
            fails = ['HUNG (suite timed out) — the instrument must fail, not hang']
            red = False  # a hang is not a kill: it is reported as SURVIVED
        verdict = 'RED' if red else 'GREEN'
        ok = (verdict == 'RED') if expected == 'RED' else True
        print(f'{mid}: {verdict} ({fails[0] if fails else "no summary"}) expected={expected} {"OK" if ok else "SURVIVED"}')
        if not ok: bad += 1
    finally:
        shutil.copy2(backup, path); os.remove(backup)
        if open(path).read() != src: print(f'{mid}: RESTORE FAILED'); bad += 1
# control: every suite a mutant is judged by is green unmutated (a suite that is red/skipped before the mutation proves nothing)
for t in sorted({TEST} | {m[5] for m in MUTANTS if len(m) > 5}):
    r = subprocess.run(['node', '--test', '--experimental-strip-types', t], cwd=ROOT, capture_output=True, text=True, timeout=180)
    skipped = [l for l in r.stdout.splitlines() if l.startswith('# skipped ')]
    print(f'CONTROL unmutated {t}: {"GREEN" if r.returncode == 0 else "RED"} ({skipped[0] if skipped else "no summary"})')
    if r.returncode != 0 or skipped != ['# skipped 0']: bad += 1
print('CLEAN' if bad == 0 else f'DIRTY ({bad})')
sys.exit(1 if bad else 0)
