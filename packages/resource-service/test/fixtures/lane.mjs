// Lane command used by the tests. Usage: lane.mjs <mode> <pidfile> [extra]
//  sleep        write own pid, then live forever
//  ignore-term  same, but SIGTERM is ignored (only SIGKILL ends it)
//  escape       DOUBLE FORK + setsid: spawn a detached child that spawns a detached `sleep` lane and exits; write the grandchild's pid; this process then exits
//  escape-stay  same as `escape` but this process stays alive
//  end-self     run `resctl run end` for its OWN run from inside this lane (extra = path of bin/resctl.mjs); write {status,stderr} as JSON, then live on
//  env-i-leave  like env-i, but this process exits at once: the marker-less child outlives the group leader
//  env-i        start `sleep` WITHOUT the run marker in the SAME process group; write its pid
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [mode, pidfile, extra] = process.argv.slice(2);
const self = new URL(import.meta.url).pathname;
const writePid = (pid) => {
  fs.writeFileSync(`${pidfile}.tmp`, typeof pid === 'string' ? pid : String(pid));
  fs.renameSync(`${pidfile}.tmp`, pidfile);
};
const hold = () => setInterval(() => {}, 1_000_000);

if (mode === 'sleep') {
  writePid(process.pid);
  hold();
} else if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {});
  writePid(process.pid);
  hold();
} else if (mode === 'end-self') {
  const r = spawnSync(process.execPath, [extra, 'run', 'end', '--id', process.env.RESCTL_RUN], { encoding: 'utf8' });
  writePid(JSON.stringify({ status: r.status, stderr: r.stderr }));
  hold();
} else if (mode === 'escape' || mode === 'escape-stay') {
  spawn(process.execPath, [self, 'escape-l1', pidfile], { detached: true, stdio: 'ignore' }).unref();
  const wait = setInterval(() => {
    if (!fs.existsSync(pidfile)) return;
    clearInterval(wait);
    if (mode === 'escape-stay') hold();
    else process.exit(0);
  }, 20);
} else if (mode === 'escape-l1') {
  spawn(process.execPath, [self, 'sleep', pidfile], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => process.exit(0), 150);
} else if (mode === 'env-i' || mode === 'env-i-leave') {
  const c = spawn('sleep', ['300'], { env: { RESCTL_STATE_DIR: process.env.RESCTL_STATE_DIR }, stdio: 'ignore' }); // same group, NO run marker (only the rig's own dir, so leaks stay findable)
  writePid(c.pid);
  if (mode === 'env-i') hold();
  else setTimeout(() => process.exit(0), 100);
} else {
  process.stderr.write(`lane.mjs: unknown mode ${mode}\n`);
  process.exit(2);
}
