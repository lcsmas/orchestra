// #406 — is the Orchestra window DISPLAYED? On sway the compositor knows exactly: a window on a workspace that is not shown has `visible: false` in `swaymsg -t get_tree`.
// Pure: the tree walk and the i3-ipc framing live here so they are tested without a compositor (main/sway-ipc.ts only owns the socket).

export interface SwayNode { pid?: number; name?: string; visible?: boolean; nodes?: SwayNode[]; floating_nodes?: SwayNode[] }

/** `visible` of OUR main window in the tree. A Wayland toplevel reports its client's pid, and a popup (#396), the login window or a detached DevTools share it, so with a `title` only leaves NAMED that
 *  count (visible if any is); no leaf with that name, or several same-pid leaves that disagree without a title, is "cannot tell" (null) — never a guess at the last leaf. null also when no such window is in the tree. */
export function windowVisibleInTree(tree: SwayNode, pid: number, title?: string): boolean | null {
  const leaves: SwayNode[] = [];
  const stack: SwayNode[] = [tree];
  while (stack.length) {
    const n = stack.pop()!;
    const kids = [...(n.nodes ?? []), ...(n.floating_nodes ?? [])];
    if (n.pid === pid && kids.length === 0 && typeof n.visible === 'boolean') leaves.push(n);
    stack.push(...kids);
  }
  const own = title === undefined ? leaves : leaves.filter((l) => l.name === title);
  if (own.length === 0) return null;
  if (title === undefined && own.some((l) => l.visible !== own[0].visible)) return null;
  return own.some((l) => l.visible === true);
}

export const IPC_MAGIC = 'i3-ipc';
export const GET_TREE = 4;
/** An i3-ipc request frame: magic, payload length (u32 LE), message type (u32 LE), payload. */
export function ipcFrame(type: number, payload = ''): Buffer {
  const body = Buffer.from(payload);
  const head = Buffer.alloc(14);
  head.write(IPC_MAGIC, 0, 'latin1');
  head.writeUInt32LE(body.length, 6);
  head.writeUInt32LE(type, 10);
  return Buffer.concat([head, body]);
}
/** Parses ONE reply out of `buf`: its payload text once complete, `'incomplete'` while more bytes are due, `null` when the header is not i3-ipc. */
export function parseIpcReply(buf: Buffer): { type: number; payload: string; used: number } | 'incomplete' | null {
  if (buf.length < 14) return 'incomplete';
  if (buf.toString('latin1', 0, 6) !== IPC_MAGIC) return null;
  const len = buf.readUInt32LE(6);
  if (buf.length < 14 + len) return 'incomplete';
  return { type: buf.readUInt32LE(10), payload: buf.toString('utf8', 14, 14 + len), used: 14 + len };
}
