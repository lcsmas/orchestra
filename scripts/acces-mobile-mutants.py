#!/usr/bin/env python3
"""Accès mobile (#334): remove each auth/bind clause in place, run the server suite, require RED, restore byte-exact.
Usage: python3 -I scripts/acces-mobile-mutants.py   (from the repo root)"""
import os, shutil, subprocess, sys, filecmp

ROOT = os.getcwd()
TEST = 'src/acces-mobile/server.test.ts'
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
    ('M15-token-dir-not-chmod', 'src/main/acces-mobile-host.ts', "  fs.chmodSync(dir, 0o700);\n", "", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('M16-boot-unguarded', 'src/main/acces-mobile-host.ts', "export function startAccesMobileHost(): void {\n  try {\n    applyAccesMobile(store.getAccesMobileSettings());\n  } catch (e) {\n    log.warn('Accès mobile could not start — the app boots without it', e);\n  }\n}", "export function startAccesMobileHost(): void {\n  applyAccesMobile(store.getAccesMobileSettings());\n}", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('Y1-non-socket-unlinked', 'src/acces-mobile/index.ts', "  if (!old.isSocket()) fail(`${sockPath} exists and is not a socket`);\n", "", 'RED'),
    ('Y2-no-fd-wrapper', 'src/main/acces-mobile-host.ts', "  const viaBash = process.platform === 'linux' && fs.existsSync('/bin/bash');", "  const viaBash = false;", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('Y3-wrapper-closes-nothing', 'src/shared/acces-mobile.ts', 'if [ "$n" -gt 2 ]; then', 'if [ "$n" -gt 99999 ]; then', 'RED'),
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
    ('S1-send-via-agent-path', 'src/main/hooks-server.ts', "                await sdkSend(ws.id, text, undefined, undefined, undefined, false, false, 'human');", "                await dispatchMessageRequest({ to: ws.id, text } as never);", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('S2-no-body-cap', 'src/acces-mobile/server.ts', "        if (Buffer.byteLength(raw) > MOBILE_SEND_MAX_BODY) {", "        if (false) {", 'RED'),
    ('S3-archived-accepted', 'src/main/hooks-server.ts', "            if (!ws || ws.archived) send(200, { ok: false, error: 'unknown or archived workspace' });", "            if (!ws) send(200, { ok: false, error: 'unknown or archived workspace' });", 'RED', 'src/main/acces-mobile-wiring.test.ts'),
    ('S4-any-content-type', 'src/acces-mobile/server.ts', "      if (!/^application\\/json\\b/i.test(String(req.headers['content-type'] ?? ''))) return refuse(415, 'not-json');\n", "", 'RED'),
    ('S5-short-send-timeout', 'src/acces-mobile/server.ts', "        relay('/mobile/send', { id, text }, 45_000);", "        relay('/mobile/send', { id, text });", 'RED'),
    ('S6-blank-accepted', 'src/acces-mobile/server.ts', "        if (typeof text !== 'string' || !text.trim() || text.length > MOBILE_SEND_MAX_CHARS) return refuse(400, 'bad-text');", "        if (typeof text !== 'string') return refuse(400, 'bad-text');", 'RED'),
    ('M9-token-read-once', 'src/acces-mobile/server.ts', "    const expected = readTokenSafe();\n", "    const expected = ((globalThis as any).__t ??= readTokenSafe()) as string;\n", 'RED'),
    ('M10-shell-without-identity', 'src/acces-mobile/server.ts', "    const login = req.headers['tailscale-user-login'];\n", "    const asset0 = STATIC[pathOnly]; if (asset0) { res.writeHead(200); res.end(asset0.body); return; }\n    const login = req.headers['tailscale-user-login'];\n", 'RED'),
]

bad = 0
ONLY = sys.argv[1:]  # optional id prefixes: run a subset (the full set is the gate)
for m in MUTANTS:
    mid, rel, old, new, expected = m[:5]
    if ONLY and not any(mid.startswith(p) for p in ONLY):
        continue
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
# control: the unmutated suite is green
r = subprocess.run(['node', '--test', '--experimental-strip-types', TEST], cwd=ROOT, capture_output=True, text=True, timeout=180)
print(f'CONTROL unmutated: {"GREEN" if r.returncode == 0 else "RED"}')
if r.returncode != 0: bad += 1
print('CLEAN' if bad == 0 else f'DIRTY ({bad})')
sys.exit(1 if bad else 0)
