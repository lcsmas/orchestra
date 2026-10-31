// #406 — ask sway whether OUR window is displayed (see shared/sway-tree.ts). Only when SWAYSOCK is set; any failure is "unknown" (null), never "hidden".
import net from 'node:net';
import { GET_TREE, ipcFrame, parseIpcReply, windowVisibleInTree, type SwayNode } from '../shared/sway-tree.ts';

/** `true` = displayed, `false` = on a workspace that is not shown, `null` = cannot tell (no sway, no such window, timeout, protocol error). `title` names the MAIN window among our pid's toplevels. */
export function swayWindowVisible(pid: number, opts: { title?: string; sock?: string; timeoutMs?: number } = {}): Promise<boolean | null> {
  const sock = 'sock' in opts ? opts.sock : process.env.SWAYSOCK;
  const timeoutMs = opts.timeoutMs ?? 250;
  if (!sock) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    const c = net.createConnection(sock);
    const finish = (v: boolean | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    c.on('error', () => finish(null));
    c.on('connect', () => c.write(ipcFrame(GET_TREE)));
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const r = parseIpcReply(buf);
      if (r === 'incomplete') return;
      if (!r) return finish(null);
      try {
        finish(windowVisibleInTree(JSON.parse(r.payload) as SwayNode, pid, opts.title));
      } catch {
        finish(null);
      }
    });
  });
}
