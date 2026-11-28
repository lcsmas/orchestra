// #695 — the pure half: the limits a member gets, the textual HostConfig rewrite, the budget verdicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIB, budgetRefusal, dockerLimitsFor, parseDockerLimitSettings, type BudgetContainer, type DockerLimits } from './docker-limits.ts';
import { createUrlPrefix, isContainerCreate, rewriteContainerCreate } from './docker-relay.ts';

const LABELS = { 'orchestra.ws': 'ws-1', 'orchestra.run': 'run-9' };
const L: DockerLimits = { memoryCeilingBytes: 6 * GIB, memoryDefaultBytes: 1.5 * GIB, budgetBytes: 6 * GIB, pidsLimit: 1024, nanoCpus: 4_000_000_000, nanoCpusDefault: 1_000_000_000, memberCpuBudget: 4_000_000_000, cpuShares: 256, hostMemBudgetBytes: 18 * GIB, hostCpuBudget: 4_000_000_000 };
const DEF = { Memory: 1.5 * GIB, MemorySwap: 1.5 * GIB, PidsLimit: 1024, NanoCpus: 1_000_000_000, CpuShares: 256 };
const hc = (text: string): Record<string, unknown> => (JSON.parse(text) as { HostConfig: Record<string, unknown> }).HostConfig;
const rw = (body: string, limits: DockerLimits | null = L) => rewriteContainerCreate(body, LABELS, limits)!;

// ── limits derivation ───────────────────────────────────────────────────────────────────────────────────────────

test('dockerLimitsFor: budget = the member cap, ceiling = budget, 1024 pids, half the cores, host 60 % RAM', () => {
  const l = dockerLimitsFor({ capHardBytes: 6 * GIB, hostTotalBytes: 32 * GIB, cpus: 8 });
  assert.deepEqual(l, { memoryCeilingBytes: 6 * GIB, memoryDefaultBytes: 1.5 * GIB, budgetBytes: 6 * GIB, pidsLimit: 1024, nanoCpus: 4e9, nanoCpusDefault: 1e9, memberCpuBudget: 4e9, cpuShares: 256, hostMemBudgetBytes: Math.floor(32 * GIB * 0.6), hostCpuBudget: 4e9 });
});

test('dockerLimitsFor: no memory_cap → a quarter of the host, clamped to [1, 8] GiB; one core → one CPU', () => {
  assert.equal(dockerLimitsFor({ hostTotalBytes: 30 * GIB, cpus: 1 }).budgetBytes, Math.floor(7.5 * GIB));
  assert.equal(dockerLimitsFor({ hostTotalBytes: 128 * GIB, cpus: 1 }).budgetBytes, 8 * GIB);
  assert.equal(dockerLimitsFor({ hostTotalBytes: 2 * GIB, cpus: 1 }).budgetBytes, 1 * GIB);
  assert.equal(dockerLimitsFor({ hostTotalBytes: 30 * GIB, cpus: 1 }).nanoCpus, 1_000_000_000);
  assert.equal(dockerLimitsFor({ capHardBytes: null, hostTotalBytes: 30 * GIB, cpus: 8 }).memoryCeilingBytes, Math.floor(7.5 * GIB));
});

test('dockerLimitsFor: env beats the settings beats the derived default; garbage is ignored', () => {
  const env = { ORCHESTRA_DOCKER_MEM_BUDGET_BYTES: '1000', ORCHESTRA_DOCKER_MEM_CEILING_BYTES: '500', ORCHESTRA_DOCKER_PIDS_LIMIT: '64', ORCHESTRA_DOCKER_NANO_CPUS: '2000000000', ORCHESTRA_DOCKER_HOST_MEM_BUDGET_BYTES: '9000', ORCHESTRA_DOCKER_HOST_NANO_CPUS: '3000000000' };
  const l = dockerLimitsFor({ capHardBytes: 6 * GIB, hostTotalBytes: 32 * GIB, cpus: 8, env, overrides: { memBudgetBytes: 1 } });
  assert.equal(l.budgetBytes, 1000);
  assert.equal(l.memoryCeilingBytes, 500);
  assert.equal(l.pidsLimit, 64);
  assert.equal(l.nanoCpus, 2e9);
  assert.equal(l.hostMemBudgetBytes, 9000);
  assert.equal(l.hostCpuBudget, 3e9);
  assert.equal(dockerLimitsFor({ capHardBytes: 6 * GIB, hostTotalBytes: 32 * GIB, cpus: 8, env: { ORCHESTRA_DOCKER_MEM_BUDGET_BYTES: 'lots' } }).budgetBytes, 6 * GIB);
  const o = dockerLimitsFor({ capHardBytes: 6 * GIB, hostTotalBytes: 32 * GIB, cpus: 8, overrides: { memBudgetBytes: 12 * GIB, memCeilingBytes: 10 * GIB, nanoCpus: 6e9, hostMemBudgetBytes: 24 * GIB, hostNanoCpus: 8e9 } });
  assert.deepEqual([o.budgetBytes, o.memoryCeilingBytes, o.nanoCpus, o.hostMemBudgetBytes, o.hostCpuBudget], [12 * GIB, 10 * GIB, 6e9, 24 * GIB, 8e9]);
});

test('parseDockerLimitSettings: host-wide keys, a workspace entry wins, garbage ignored', () => {
  const f = JSON.stringify({ memBudgetGb: 12, cpus: 6, hostMemBudgetGb: 20, hostCpus: 8, workspaces: { 'ws-1': { memBudgetGb: 16, memCeilingGb: 14 } } });
  assert.deepEqual(parseDockerLimitSettings(f, 'ws-1'), { memBudgetBytes: 16 * GIB, memCeilingBytes: 14 * GIB, nanoCpus: 6e9, hostMemBudgetBytes: 20 * GIB, hostNanoCpus: 8e9 });
  assert.deepEqual(parseDockerLimitSettings(f, 'ws-2'), { memBudgetBytes: 12 * GIB, nanoCpus: 6e9, hostMemBudgetBytes: 20 * GIB, hostNanoCpus: 8e9 });
  for (const bad of [null, '', 'not json', '[]', '{"memBudgetGb":-1,"cpus":"x"}']) assert.deepEqual(parseDockerLimitSettings(bad, 'ws-1'), {}, String(bad));
});

// ── the create rewrite ──────────────────────────────────────────────────────────────────────────────────────────

test('no HostConfig: the limits are added, with the labels, and nothing else moves', () => {
  const r = rw('{"Image":"node:10","Cmd":["npm","test"]}');
  assert.deepEqual(hc(r.text), DEF);
  const j = JSON.parse(r.text) as Record<string, unknown>;
  assert.equal(j.Image, 'node:10');
  assert.deepEqual(j.Cmd, ['npm', 'test']);
  assert.deepEqual(j.Labels, LABELS);
  assert.equal(r.memoryBytes, BigInt(1.5 * GIB));
  assert.equal(r.nanoCpus, 1_000_000_000n);
  assert.deepEqual(r.changes.map((c) => `${c.field}:${c.kind}`), ['Memory:set', 'MemorySwap:set', 'PidsLimit:set', 'NanoCpus:set', 'CpuShares:set']);
});

test('HostConfig with other fields: they stay byte-for-byte, the limits go in front', () => {
  const inner = '"Binds":["/a:/b:ro"],  "NetworkMode":"bridge","RestartPolicy":{"Name":"no"},"Ulimits":[{"Name":"nofile","Soft":9223372036854775807,"Hard":9223372036854775807}]';
  const body = `{"Image":"mongo:7","HostConfig":{${inner}},"Env":["A=1"]}`;
  const r = rw(body);
  assert.ok(r.text.includes(inner), 'the original HostConfig members are untouched, text for text (the > 2^53 ulimit survives)');
  assert.equal(hc(r.text).Memory, 1.5 * GIB);
  assert.ok(r.text.includes('"Env":["A=1"]'));
});

test('a client Memory above the ceiling is clamped; up to the ceiling and below are kept; >2^53 is compared exactly', () => {
  assert.equal(hc(rw('{"HostConfig":{"Memory":34359738368}}').text).Memory, 6 * GIB);
  assert.deepEqual(rw('{"HostConfig":{"Memory":34359738368}}').changes[0], { field: 'Memory', kind: 'clamped', from: '34359738368', to: String(6 * GIB) });
  assert.equal(hc(rw('{"HostConfig":{"Memory":6442450944}}').text).Memory, 6 * GIB, 'one big container stays possible: the ceiling is the budget');
  const small = rw('{"HostConfig":{"Memory":536870912}}');
  assert.equal(hc(small.text).Memory, 536870912);
  assert.equal(hc(small.text).MemorySwap, 536870912, 'no swap: MemorySwap follows the kept Memory');
  assert.equal(small.memoryBytes, 536870912n);
  assert.equal(hc(rw('{"HostConfig":{"Memory":9223372036854775807}}').text).Memory, 6 * GIB); // a number JSON.parse cannot hold exactly
});

test('MemorySwap: -1 / below Memory / above the ceiling → Memory; a value between Memory and the ceiling is kept', () => {
  assert.equal(hc(rw('{"HostConfig":{"Memory":1073741824,"MemorySwap":-1}}').text).MemorySwap, 1073741824);
  assert.equal(hc(rw('{"HostConfig":{"Memory":1073741824,"MemorySwap":536870912}}').text).MemorySwap, 1073741824);
  assert.deepEqual(rw('{"HostConfig":{"Memory":1073741824,"MemorySwap":99999999999}}').changes.find((c) => c.field === 'MemorySwap')?.kind, 'clamped');
  assert.equal(hc(rw('{"HostConfig":{"Memory":1073741824,"MemorySwap":2147483648}}').text).MemorySwap, 2147483648);
});

test('PidsLimit, NanoCpus, CpuShares: unset or above → the cap; below → kept', () => {
  const big = hc(rw('{"HostConfig":{"PidsLimit":100000,"NanoCpus":64000000000,"CpuShares":1024}}').text);
  assert.deepEqual([big.PidsLimit, big.NanoCpus, big.CpuShares], [1024, 4_000_000_000, 256]);
  assert.equal(hc(rw('{"HostConfig":{"PidsLimit":-1}}').text).PidsLimit, 1024);
  const small = hc(rw('{"HostConfig":{"PidsLimit":64,"NanoCpus":500000000,"CpuShares":128}}').text);
  assert.deepEqual([small.PidsLimit, small.NanoCpus, small.CpuShares], [64, 500000000, 128]);
  assert.equal(hc(rw('{"HostConfig":{"NanoCpus":4000000000}}').text).NanoCpus, 4_000_000_000, 'an explicit ask may reach the ceiling');
});

test('CpuShares is stamped below the engine default on every create', () => {
  assert.equal(hc(rw('{"Image":"x"}').text).CpuShares, 256);
  assert.equal(hc(rw('{"HostConfig":{"CpuShares":0}}').text).CpuShares, 256);
});

test('NanoCpus is left alone when the client set CpuQuota/CpuPeriod/CpuCount (dockerd refuses the mix)', () => {
  for (const k of ['CpuQuota', 'CpuPeriod', 'CpuCount']) {
    const r = rw(`{"HostConfig":{"${k}":50000}}`);
    assert.equal('NanoCpus' in hc(r.text), false, k);
    assert.equal(r.nanoCpus, 0n);
    assert.equal(hc(r.text).Memory, 1.5 * GIB);
  }
  assert.equal(hc(rw('{"HostConfig":{"CpuQuota":0,"CpuPeriod":0}}').text).NanoCpus, 1_000_000_000); // compose's explicit zeros are "unset"
});

test('compose-style body: explicit zeros / nulls are replaced IN PLACE (no duplicate key), the rest is untouched', () => {
  const body = '{"Image":"x","Labels":{"com.docker.compose.project":"p"},"HostConfig":{"Binds":null,"NetworkMode":"p_default","CpuShares":0,"Memory":0,"MemorySwap":0,"MemorySwappiness":null,"NanoCpus":0,"PidsLimit":null,"OomKillDisable":false}}';
  const r = rw(body);
  assert.deepEqual(hc(r.text), { Binds: null, NetworkMode: 'p_default', CpuShares: 256, Memory: 1.5 * GIB, MemorySwap: 1.5 * GIB, MemorySwappiness: null, NanoCpus: 1_000_000_000, PidsLimit: 1024, OomKillDisable: false });
  for (const k of ['Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'CpuShares']) assert.equal(r.text.split(`"${k}":`).length - 1, 1, `${k} appears once`);
  assert.deepEqual((JSON.parse(r.text) as { Labels: unknown }).Labels, { 'com.docker.compose.project': 'p', ...LABELS });
});

test('HostConfig: null becomes an object with the limits; a non-object is not editable (null → forwarded untouched)', () => {
  assert.equal(hc(rw('{"Image":"x","HostConfig":null}').text).Memory, 1.5 * GIB);
  assert.equal(hc(rw('{"HostConfig":{}}').text).PidsLimit, 1024);
  assert.equal(rewriteContainerCreate('{"HostConfig":"nope"}', LABELS, L), null);
  assert.equal(rewriteContainerCreate('{"HostConfig":{"Memory":', LABELS, L), null);
});

test('without limits the rewrite is the labels-only #291 stamp, HostConfig untouched', () => {
  const r = rewriteContainerCreate('{"Image":"x","HostConfig":{"Memory":0}}', LABELS, null)!;
  assert.equal(r.text, `{"Labels":{"orchestra.ws":"ws-1","orchestra.run":"run-9"},"Image":"x","HostConfig":{"Memory":0}}`);
  assert.equal(r.memoryBytes, null);
  assert.deepEqual(r.changes, []);
});

test('versioned URLs: a /v1.43 create is a create and its prefix is kept for the relay\'s own daemon calls', () => {
  assert.equal(isContainerCreate('POST', '/v1.43/containers/create?name=x'), true);
  assert.equal(createUrlPrefix('/v1.43/containers/create?name=x'), '/v1.43');
  assert.equal(createUrlPrefix('/containers/create'), '');
});

// ── the budget verdicts ─────────────────────────────────────────────────────────────────────────────────────────

const c = (name: string, ws: string, memGib: number, cpus = 0): BudgetContainer => ({ name, ws, memoryBytes: memGib * GIB, nanoCpus: cpus * 1e9 });
const ask = (memGib: number, cpus = 0) => ({ memoryBytes: memGib * GIB, nanoCpus: cpus * 1e9 });

test('member memory: fits (exactly the budget) → null; over → names the budget, the sum in use, the users and how to free', () => {
  assert.equal(budgetRefusal(L, 'ws-1', ask(2), [c('a', 'ws-1', 4)]), null);
  const r = budgetRefusal(L, 'ws-1', ask(2.5), [c('pl-node', 'ws-1', 4)])!;
  assert.deepEqual([r.scope, r.resource, r.inUse], ['member', 'memory', 4 * GIB]);
  assert.match(r.message, /memory budget exceeded/);
  assert.match(r.message, /this workspace may hold 6\.00 GiB/);
  assert.match(r.message, /4\.00 GiB is already reserved/);
  assert.match(r.message, /pl-node/);
  assert.match(r.message, /docker rm -f/);
  assert.match(r.message, /--memory/);
});

test('a container created without a limit counts as the ceiling (memory and CPU)', () => {
  const r = budgetRefusal(L, 'ws-1', ask(0.001), [{ name: 'old', ws: 'ws-1', memoryBytes: 0, nanoCpus: 0 }])!;
  assert.equal(r.inUse, 6 * GIB);
  assert.match(r.message, /no limit, counted as 6\.00 GiB/);
  const cpu = budgetRefusal({ ...L, budgetBytes: 100 * GIB }, 'ws-1', ask(0.001, 1), [{ name: 'old', ws: 'ws-1', memoryBytes: 1, nanoCpus: 0 }])!;
  assert.deepEqual([cpu.scope, cpu.resource, cpu.inUse], ['member', 'cpu', 4e9]);
});

test('member CPU: the sum of NanoCpus over the member\'s containers may not pass its budget', () => {
  assert.equal(budgetRefusal(L, 'ws-1', ask(0.1, 1), [c('a', 'ws-1', 0.1, 3)]), null); // 3 + 1 = 4 CPU = the budget
  const r = budgetRefusal(L, 'ws-1', ask(0.1, 1.5), [c('a', 'ws-1', 0.1, 3)])!;
  assert.deepEqual([r.scope, r.resource], ['member', 'cpu']);
  assert.match(r.message, /this workspace may hold 4 CPU/);
  assert.match(r.message, /3 CPU is already reserved/);
  assert.match(r.message, /--cpus/);
});

test('host-wide: two members each under their own budget but together over the host budget → the second is refused, naming the top users', () => {
  const l = { ...L, hostMemBudgetBytes: 8 * GIB };
  const all = [c('db', 'ws-A', 5)];
  assert.equal(budgetRefusal(l, 'ws-A', ask(1), all), null); // A alone: 6 ≤ its 6 GiB budget and ≤ the host's 8
  const r = budgetRefusal(l, 'ws-B', ask(4), all)!; // B is empty (4 ≤ 6) but 5 + 4 = 9 > 8
  assert.deepEqual([r.scope, r.resource, r.inUse], ['host', 'memory', 5 * GIB]);
  assert.match(r.message, /ALL workspaces together \(the host-wide budget\) may hold 8\.00 GiB/);
  assert.match(r.message, /db of ws-A/);
});

test('host-wide CPU: members together may not pass the host CPU budget', () => {
  const r = budgetRefusal({ ...L, hostCpuBudget: 4e9 }, 'ws-B', ask(0.1, 2), [c('x', 'ws-A', 0.1, 3)])!;
  assert.deepEqual([r.scope, r.resource, r.inUse], ['host', 'cpu', 3e9]);
  assert.match(r.message, /x of ws-A/);
});
