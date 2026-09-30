// In-run CONTAINMENT CANARY (#208 follow-up): prove the network namespace is routeless by ASKING it, not by trusting the
// name the harness gave it. Probes documentation-range addresses (RFC 5737 192.0.2.1, RFC 3849 2001:db8::1 — never routable,
// so the probe is harmless even when containment is broken) and reads the namespace's interfaces and routes.
// Judged by `judgeContainmentProof` (src/shared/session-budget.ts).
import fs from 'node:fs';
import net from 'node:net';

export const CANARY = Object.freeze({ v4: '192.0.2.1', v6: '2001:db8::1', port: 443 });

function connectOnce(host, family, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: CANARY.port, family });
    const done = (r) => { try { s.destroy(); } catch { /* gone */ } resolve(r); };
    const t = setTimeout(() => done('TIMEOUT'), timeoutMs);
    s.once('connect', () => { clearTimeout(t); done('CONNECTED'); });
    s.once('error', (e) => { clearTimeout(t); done(e.code ?? String(e.message)); });
  });
}

const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return null; } };

/**
 * `procNet` and `connect` are injectable so the probe's own logic is unit-tested against fake /proc files and a stub connect
 * (the real thing runs in the suite's `containment-canary` arm and in every session arm).
 * @returns {Promise<{connect4:string, connect6:string, interfaces:string[], nonLoopbackRoutes:number}>}
 */
export async function containmentCanary({ timeoutMs = 1500, procNet = '/proc/net', connect = connectOnce } = {}) {
  const [connect4, connect6] = await Promise.all([connect(CANARY.v4, 4, timeoutMs), connect(CANARY.v6, 6, timeoutMs)]);
  const dev = lines(`${procNet}/dev`);
  const interfaces = dev ? dev.slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean).sort() : ['UNREADABLE'];
  const r4 = lines(`${procNet}/route`);
  const r6 = lines(`${procNet}/ipv6_route`);
  // v4: header + `Iface Destination …`; v6: `dest plen src plen nexthop metric refcnt use flags iface`.
  const nonLoopbackRoutes = (r4 ? r4.slice(1).filter((l) => l.split(/\s+/)[0] !== 'lo').length : 1000) + (r6 ? r6.filter((l) => l.trim().split(/\s+/).pop() !== 'lo').length : 0);
  return { connect4, connect6, interfaces, nonLoopbackRoutes };
}
