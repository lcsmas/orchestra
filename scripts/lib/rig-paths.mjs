// Physical (symlink-resolved) views of paths for rig preflights: a LEXICAL check passes `<rig>/xdg -> /run/user/1000`; these see through it.
// Only ever called on values that already passed the lexical checks, so nothing here walks into the human's runtime dir on a hostile input.
import fs from 'node:fs';
import path from 'node:path';

/** realpath of the deepest EXISTING ancestor of `p`, plus the not-yet-existing remainder — so a path that is about to be created under a symlinked
 *  parent resolves to where it WOULD land (a plain realpath throws on a missing leaf; path.resolve ignores links). */
export function physicalPath(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* missing: climb */ }
    const up = path.dirname(cur);
    if (up === cur) return abs;
    rest.push(path.basename(cur));
    cur = up;
  }
}

/** Every physical form of one absolute path piece: its realpath (when it exists) and, if it is itself a symlink, the target it points at (also when dangling). */
export function physicalForms(piece) {
  const out = [];
  try { out.push(fs.realpathSync(piece)); } catch { /* missing or dangling */ }
  out.push(physicalPath(piece)); // a MISSING leaf under a linked parent (`<link>/bus`) still lands where the link points
  try {
    if (fs.lstatSync(piece).isSymbolicLink()) out.push(path.resolve(path.dirname(piece), fs.readlinkSync(piece)));
  } catch { /* not there */ }
  return out;
}

// split two ways: on whitespace too (a `:`/space separated list) and NOT on whitespace (one decoded path that has a space in it)
const piecesOf = (v) => [...new Set([...v.split(/[:=,;\s]+/), ...v.split(/[:=,;]+/)])].filter((x) => x.startsWith('/'));

/** The absolute path pieces an env value names (a plain path, a `:`-list, `unix:path=…`) — of the value AS GIVEN and of its single-pass `%hh`-decoded form
 *  (a D-Bus address escapes bytes that way: `unix:path=%2Fsrv%2Flink%2Fbus` names `/srv/link/bus`). A malformed escape decodes to nothing here: the LEXICAL
 *  stage (`referencesHumanRuntime`) already refuses it, fail closed, before this is ever reached. */
export function absolutePieces(value) {
  const v = String(value);
  const out = piecesOf(v);
  if (v.includes('%')) {
    try { out.push(...piecesOf(decodeURIComponent(v))); } catch { /* malformed: refused lexically */ }
  }
  return [...new Set(out)];
}
