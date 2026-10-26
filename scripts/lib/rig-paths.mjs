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
  try {
    if (fs.lstatSync(piece).isSymbolicLink()) out.push(path.resolve(path.dirname(piece), fs.readlinkSync(piece)));
  } catch { /* not there */ }
  return out;
}

/** The absolute path pieces an env value names (a plain path, a `:`-list, `unix:path=…`). */
export const absolutePieces = (value) => String(value).split(/[:=,;\s]+/).filter((x) => x.startsWith('/'));
