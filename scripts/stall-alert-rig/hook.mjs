// Fire a REAL lifecycle event at the running app over its own unix socket —
// the same route the per-worktree hook scripts use. This drives the actual
// producer chain (dispatchHookEvent -> applyAgentEvent -> case 'submit' ->
// setStatus(id,'running',null,TRUE) -> lastTurnStartAt), which is precisely
// the seam that cannot be executed under `node --test`.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
const home = process.argv[2], id = process.argv[3], event = process.argv[4];
const hash = crypto.createHash('sha256').update(home).digest('hex').slice(0, 12);
const sock = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', `orchestra-${hash}.sock`);
const body = JSON.stringify({ id, event });
const req = http.request({ socketPath: sock, path: '/event', method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
  (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>console.log(`HOOK ${event} -> ${id} rc=${res.statusCode} ${d}`)); });
req.on('error', (e) => { console.log(`HOOK_ERR sock=${sock} ${e.message}`); process.exit(1); });
req.end(body);
