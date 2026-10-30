// Electron fuse wire of a packaged binary (#407): parsed from the raw bytes, independent of @electron/fuses (whose getCurrentFuseWire is the
// cross-check). CommonJS so electron-builder's afterPack hook and the .mjs rigs share ONE reader; unit tests: src/shared/fuse-wire.test.ts.
// Wire = SENTINEL · version byte · length byte · one state byte per fuse ('0' disabled, '1' enabled, 'r' removed), in the V1 order below.
'use strict';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const V1_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
];
const STATE = { 0x30: 'disabled', 0x31: 'enabled', 0x72: 'removed' };

/** Parse the fuse wire out of a binary (Buffer). Never throws: `{ ok:false, reason }` when it is not exactly one well-formed V1 wire. */
function parseFuseWire(buf) {
  const needle = Buffer.from(SENTINEL, 'latin1');
  const first = buf.indexOf(needle);
  if (first < 0) return { ok: false, reason: 'sentinel not found — not an Electron binary with a fuse wire' };
  if (buf.indexOf(needle, first + needle.length) >= 0) return { ok: false, reason: 'sentinel found more than once (universal binary or a copied string) — refusing to guess which wire is live' };
  const at = first + needle.length;
  if (at + 2 > buf.length) return { ok: false, reason: 'binary ends inside the fuse wire header' };
  const version = buf[at];
  const length = buf[at + 1];
  if (version !== 1) return { ok: false, reason: `unsupported fuse wire version ${version} (this reader knows V1)` };
  if (at + 2 + length > buf.length) return { ok: false, reason: `wire length ${length} runs past the end of the binary` };
  if (length < V1_NAMES.length) return { ok: false, reason: `wire has ${length} fuses, fewer than the ${V1_NAMES.length} V1 fuses this reader names` };
  const fuses = {};
  for (let i = 0; i < length; i++) {
    const b = buf[at + 2 + i];
    const state = STATE[b];
    if (!state) return { ok: false, reason: `fuse #${i} has state byte 0x${b.toString(16)} (expected '0', '1' or 'r')` };
    fuses[i < V1_NAMES.length ? V1_NAMES[i] : `fuse#${i}`] = state;
  }
  return { ok: true, version, offset: at + 2, fuses };
}

/** Parse the file at `file` (reads it whole: the Electron binary is ~200 MB). */
function readFuseWireFile(file) {
  return parseFuseWire(require('node:fs').readFileSync(file));
}

/** Byte offset (in the binary) of the EnableCookieEncryption state byte, or -1 when the wire does not parse. */
function cookieFuseOffset(buf) {
  const w = parseFuseWire(buf);
  return w.ok ? w.offset + V1_NAMES.indexOf('EnableCookieEncryption') : -1;
}

/**
 * Does the packaged binary's wire say what the shipped policy (`COOKIE_ENCRYPTION_FUSE_SHIPPED`) and PROFILE_AT_REST_WARNING assume? Pure; `{ ok, message }`.
 * An unreadable wire is a FAILURE (a build that cannot prove the fuse state must not ship a warning that depends on it).
 */
function expectCookieFuse(wire, shipped) {
  if (!wire || !wire.ok) return { ok: false, message: `cannot read the fuse wire of the packaged binary (${wire && wire.reason ? wire.reason : 'no wire'}) — the build cannot prove what the profile at-rest warning assumes` };
  const got = wire.fuses.EnableCookieEncryption;
  const want = shipped ? 'enabled' : 'disabled';
  if (got === want) return { ok: true, message: `EnableCookieEncryption ${got} in the packaged binary — matches the shipped policy (COOKIE_ENCRYPTION_FUSE_SHIPPED=${shipped})` };
  return { ok: false, message: `EnableCookieEncryption is ${got} in the packaged binary but the shipped policy (scripts/lib/cookie-fuse-policy.cjs COOKIE_ENCRYPTION_FUSE_SHIPPED=${shipped}) expects ${want} — PROFILE_AT_REST_WARNING and ADR 0010 would misstate where cookies sit on disk` };
}

module.exports = { SENTINEL, V1_NAMES, parseFuseWire, readFuseWireFile, cookieFuseOffset, expectCookieFuse };
