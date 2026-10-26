// Measured mountinfo shapes for the keyring rig's hidden-world proof (shared by the unit and driver tests; not a test file).
import { humanRuntimeDir } from './keyring-rig-world.ts';

const HUMAN = humanRuntimeDir(1000);

/** the host: exactly ONE mount at the runtime dir (real values from this machine, trimmed) */
export const HOST_MI = `472 50 0:64 / ${HUMAN} rw,nosuid,nodev,relatime shared:223 - tmpfs tmpfs rw,seclabel,size=3241904k,nr_inodes=810476,mode=700,uid=1000,gid=1000,inode64
473 472 0:85 / ${HUMAN}/doc rw,nosuid,nodev,relatime shared:889 - fuse.portal portal rw,user_id=1000,group_id=1000
`;
/** the rig's hidden world (bwrap --tmpfs over it): the inherited real mount, then a FRESH private tmpfs stacked on it (measured with the rig's own bwrap shape) */
export const HIDDEN_MI = `1372 1369 0:64 / ${HUMAN} rw,nosuid,nodev,relatime master:223 - tmpfs tmpfs rw,seclabel,size=3241904k,nr_inodes=810476,mode=700,uid=1000,gid=1000,inode64
1373 1372 0:85 / ${HUMAN}/doc rw,nosuid,nodev,relatime master:889 - fuse.portal portal rw,user_id=1000,group_id=1000
1392 1372 0:89 / ${HUMAN} rw,nosuid,nodev,relatime - tmpfs tmpfs rw,seclabel,mode=755,uid=1000,gid=1000,inode64
`;

/** (a) `mount --bind P P` inside a private namespace: 2 mounts, private untagged tmpfs on top — but the SAME device as the real mount (round-6 MAJOR, real format) */
export const SELF_BIND_MI = `472 50 0:64 / ${HUMAN} rw,nosuid,nodev,relatime shared:223 - tmpfs tmpfs rw,seclabel,size=3241904k,nr_inodes=810476,mode=700,uid=1000,gid=1000,inode64
1500 472 0:64 / ${HUMAN} rw,nosuid,nodev,relatime - tmpfs tmpfs rw,seclabel,size=3241904k,nr_inodes=810476,mode=700,uid=1000,gid=1000,inode64
`;

/** (b) host + a hide + a RE-BIND of the real dir at the same point: the re-bind becomes the topmost mount and exposes it (3 mounts) */
export const REBIND_ON_HIDE_MI = `${HIDDEN_MI}1500 1392 0:64 / ${HUMAN} rw,nosuid,nodev,relatime - tmpfs tmpfs rw,seclabel,size=3241904k,nr_inodes=810476,mode=700,uid=1000,gid=1000,inode64
`;
