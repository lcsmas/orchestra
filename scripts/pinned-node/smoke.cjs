// Packaging-time smoke for the pinned Node (#390): the runtime under test STARTS the real keeper bundle, which answers a `hello`
// and relays a child's stdio. A runtime that cannot exec, runs the wrong version, or cannot host the keeper fails here — and the
// release build with it (pack-check.cjs calls this from afterPack).
//   node scripts/pinned-node/smoke.cjs --node <runtime> --keeper <keeper.js> [--expect-version 22.23.4]
// Terminator on stdout: `PINNED-NODE-SMOKE: PASS …` (rc 0) or `PINNED-NODE-SMOKE: FAIL …` (rc 1). Anything else is not a verdict.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

/** The "CLI" the keeper hosts: echoes {"echo":X} lines as {"type":"assistant","echo":X} (same shape keeper.test.ts uses). */
const ECHO_CLI =
  "let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);" +
  "try{const m=JSON.parse(l);if(m.echo!==undefined)process.stdout.write(JSON.stringify({type:'assistant',echo:m.echo})+'\\n')}catch{}}});" +
  'process.stdin.on("end",()=>process.exit(0))';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectRetry(sock, child, ms) {
  const deadline = Date.now() + ms;
  return (async () => {
    let last = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`keeper process exited before listening (code ${child.exitCode}, signal ${child.signalCode})`);
      try {
        return await new Promise((resolve, reject) => {
          const s = net.connect(sock);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
      } catch (e) {
        last = e;
        await sleep(50);
      }
    }
    throw new Error(`keeper socket never accepted a connection within ${ms} ms (${last && last.message})`);
  })();
}

/** Frame reader over a socket: `next(pred, ms)` resolves with the first parsed frame matching pred (earlier frames stay queued for later calls). */
function frameReader(s) {
  const queue = [];
  const waiters = [];
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        queue.push(JSON.parse(line));
      } catch {
        /* garbage line */
      }
    }
    for (const w of waiters.splice(0)) w();
  });
  s.on('close', () => {
    for (const w of waiters.splice(0)) w();
  });
  return {
    async next(pred, ms, what) {
      const deadline = Date.now() + ms;
      for (;;) {
        const idx = queue.findIndex(pred);
        if (idx >= 0) return queue.splice(idx, 1)[0];
        if (Date.now() >= deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
  };
}

/**
 * Run `keeperJs` under `nodePath` and drive it over its socket. Resolves with { version, exe } on success; rejects with an Error whose message is
 * the first thing that was wrong. Linux only for the `/proc/<pid>/exe` identity proof (skipped elsewhere, stated in the result).
 */
async function smokeKeeper({ nodePath, keeperJs, expectVersion, timeoutMs = 20000 }) {
  if (!fs.existsSync(nodePath)) throw new Error(`runtime missing: ${nodePath}`);
  if (!fs.existsSync(keeperJs)) throw new Error(`keeper bundle missing: ${keeperJs}`);
  // 1. the runtime executes at all, and it is the pinned version
  let version;
  try {
    version = execFileSync(nodePath, ['-p', 'process.version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } }).trim();
  } catch (e) {
    throw new Error(`the runtime does not execute (${String((e.stderr && e.stderr.toString()) || e.message).split('\n')[0].slice(0, 200)})`);
  }
  if (expectVersion && version !== `v${expectVersion}`) throw new Error(`runtime reports ${version}, pinned v${expectVersion}`);

  // 2. it hosts the real keeper: scratch dir short enough for a unix socket path, allowlisted env, bounded lifetime if we die mid-way
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnsmoke-'));
  const sock = path.join(dir, 'k.sock');
  const logFile = path.join(dir, 'k.log');
  const wsId = 'smoke-' + path.basename(dir);
  const env = { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, ORCHESTRA_KEEPER_LINGER_MS: '30000', ORCHESTRA_KEEPER_WEDGE_MS: '30000', ORCHESTRA_KEEPER_TICK_MS: '2000' };
  const keeper = spawn(nodePath, [keeperJs, wsId, sock, path.join(dir, 'k.pid'), logFile], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env });
  let stderr = '';
  keeper.stderr.on('data', (d) => (stderr += d));
  let exe = null;
  let s = null;
  try {
    s = await connectRetry(sock, keeper, timeoutMs);
    if (process.platform === 'linux') {
      exe = fs.readlinkSync(`/proc/${keeper.pid}/exe`);
      const want = fs.realpathSync(nodePath);
      if (exe !== want) throw new Error(`the keeper is NOT running on the runtime under test: /proc/${keeper.pid}/exe → ${exe}, expected ${want}`);
    }
    const rd = frameReader(s);
    const send = (f) => s.write(JSON.stringify(f) + '\n');
    send({ t: 'hello', wsId });
    const ack = await rd.next((f) => f.t === 'helloAck' || f.t === 'err', 10000, 'helloAck');
    if (ack.t !== 'helloAck' || ack.wsId !== wsId || ack.running !== false) throw new Error(`unexpected hello answer: ${JSON.stringify(ack)}`);
    // The relay path: spawn a child (the runtime itself), write a line to its stdin, read the echo back through the keeper.
    send({ t: 'spawn', command: nodePath, args: ['-e', ECHO_CLI], cwd: dir, env: { PATH: '/usr/bin:/bin' } });
    send({ t: 'stdin', b64: Buffer.from(JSON.stringify({ echo: 'pinned-node-smoke' }) + '\n').toString('base64') });
    const got = await rd.next((f) => f.t === 'stdout' || f.t === 'err' || f.t === 'exit', 10000, 'the child echo');
    if (got.t !== 'stdout') throw new Error(`the keeper did not relay the child's stdout: ${JSON.stringify(got)}`);
    const text = Buffer.from(got.b64, 'base64').toString('utf8');
    if (!text.includes('"echo":"pinned-node-smoke"')) throw new Error(`the relayed stdout is not the echo: ${text.slice(0, 120)}`);
    send({ t: 'kill', signal: 'SIGKILL' });
    await rd.next((f) => f.t === 'exit', 10000, 'the child exit after kill');
    return { version, exe };
  } catch (e) {
    let tail = '';
    try {
      tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' | ');
    } catch {
      /* no log */
    }
    throw new Error(`${e.message}${stderr ? ` [keeper stderr: ${stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}]` : ''}${tail ? ` [keeper log: ${tail.slice(0, 300)}]` : ''}`);
  } finally {
    if (s) s.destroy();
    // Our own direct child handle: group-kill the keeper (and anything it spawned) — no pgrep, no host-wide match.
    if (keeper.exitCode === null && keeper.signalCode === null) {
      try {
        process.kill(-keeper.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { smokeKeeper };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const nodePath = arg('--node');
  const keeperJs = arg('--keeper');
  if (!nodePath || !keeperJs) {
    console.log('PINNED-NODE-SMOKE: FAIL usage: --node <runtime> --keeper <keeper.js> [--expect-version X.Y.Z]');
    process.exit(2);
  }
  smokeKeeper({ nodePath, keeperJs, expectVersion: arg('--expect-version') }).then(
    (r) => console.log(`PINNED-NODE-SMOKE: PASS node=${nodePath} version=${r.version} keeperExe=${r.exe}`),
    (e) => {
      console.log(`PINNED-NODE-SMOKE: FAIL ${e.message}`);
      process.exit(1);
    }
  );
}
