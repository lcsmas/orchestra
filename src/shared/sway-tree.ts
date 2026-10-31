// #406 — is the Orchestra window DISPLAYED? On sway the compositor knows exactly: a window on a workspace that is not shown has `visible: false` in `swaymsg -t get_tree`.
// Pure: the tree walk and the i3-ipc framing live here so they are tested without a compositor (main/sway-ipc.ts only owns the socket).

export interface SwayNode { pid?: number; visible?: boolean; nodes?: SwayNode[]; floating_nodes?: SwayNode[] }

/** `visible` of the leaf window owned by `pid` (a Wayland toplevel reports its client's pid), or null when no such window is in the tree. */
export function windowVisibleInTree(tree: SwayNode, pid: number): boolean | null {
  const stack: SwayNode[] = [tree];
  while (stack.length) {
    const n = stack.pop()!;
    const kids = [...(n.nodes ?? []), ...(n.floating_nodes ?? [])];
    if (n.pid === pid && kids.length === 0 && typeof n.visible === 'boolean') return n.visible;
    stack.push(...kids);
  }
  return null;
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
