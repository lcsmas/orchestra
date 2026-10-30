// What this release SHIPS for Electron's EnableCookieEncryption fuse (#407) — the ONE switch behind three things that must agree:
//   1. scripts/after-pack-check.cjs flips the fuse iff it is true, then reads the packaged binary's wire and FAILS the release if the binary disagrees;
//   2. the Settings > Browser at-rest warning (src/shared/cookie-fuse-policy.ts profileAtRestWarning) is derived from the REAL state, and its always-on form is only right while this is false;
//   3. ADR 0010 / docs/codebase-map/browser-panel.md § At rest.
// TRUE only on the HELD flip commit (#407): it merges after the maintainer's explicit OK of the measured trap (docs/evidence/407-cookie-fuse.jsonl: once a sealed row exists, a start that cannot decrypt it deletes the whole jar).
'use strict';
module.exports = { COOKIE_ENCRYPTION_FUSE_SHIPPED: true };
