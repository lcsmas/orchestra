// Widens two windows in ONE keeper daemon (env-gated): the staleness-verdict -> rename gap and the rename -> link-back gap.
const fs = require('fs');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const V = Number(process.env.P1_VERDICT_MS || 0), W = Number(process.env.P1_WINDOW_MS || 0);
const realKill = process.kill.bind(process);
process.kill = function (pid, sig) { try { return realKill(pid, sig); } catch (e) { if (sig === 0 && V) sleep(V); throw e; } };
const realRename = fs.renameSync;
fs.renameSync = function (a, b) { const r = realRename.apply(fs, arguments); if (String(b).includes('.claim.stale.') && W) sleep(W); return r; };
