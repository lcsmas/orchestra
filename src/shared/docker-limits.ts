// #695 — what the Docker relay imposes on a member's containers: a per-container ceiling (Memory / MemorySwap / PidsLimit /
// NanoCpus stamped at create) and a per-member memory BUDGET (refuse a create that would push the sum of the member's
// containers over it). Pure: the numbers and the refusal text; the keeper's relay does the I/O. Why it exists: containers
// live under dockerd (`system.slice`), outside the member's memory_cap scope, so a runaway test suite in a container froze
// the laptop twice (global OOM, 2026-11-28).

export const GIB = 1024 * 1024 * 1024;

export const DEFAULT_PIDS_LIMIT = 1024;
/** A container's CPU weight under contention (the engine default is 1024): the desktop and the agent sessions win. */
export const DEFAULT_CPU_SHARES = 256;
/** Host fallback (no memory_cap on this member): a quarter of the host's RAM, never under 1 GiB nor over 8 GiB. */
export const HOST_BUDGET_FRACTION = 0.25;
export const HOST_BUDGET_MIN_BYTES = 1 * GIB;
export const HOST_BUDGET_MAX_BYTES = 8 * GIB;
/** Every member's containers together may hold this share of the host's RAM. */
export const HOST_MEMORY_SHARE = 0.6;
/** A create that leaves `Memory` / `NanoCpus` unset gets this fraction of the ceiling, so a stack (db + app + …) fits the budget; an explicit ask may go up to the ceiling. */
export const DEFAULT_SHARE = 0.25;

export interface DockerLimits {
  /** The largest `HostConfig.Memory` a client may ask for (= the member budget by default: one big container stays possible); `MemorySwap` is held to it too (no swap). */
  memoryCeilingBytes: number;
  /** `HostConfig.Memory` when the client left it unset: a quarter of the ceiling. */
  memoryDefaultBytes: number;
  /** The sum of `Memory` over the member's containers may not pass this. */
  budgetBytes: number;
  pidsLimit: number;
  /** The largest `HostConfig.NanoCpus` (half the host cores). */
  nanoCpus: number;
  /** `NanoCpus` when the client left it unset: a quarter of the ceiling, at least one core. */
  nanoCpusDefault: number;
  /** The sum of `NanoCpus` over the member's containers may not pass this (half the host cores). */
  memberCpuBudget: number;
  cpuShares: number;
  /** ALL members' containers together (every `orchestra.ws`-labelled container): memory (60 % of RAM) and CPU (half the cores). */
  hostMemBudgetBytes: number;
  hostCpuBudget: number;
}

export const ENV_DOCKER_MEM_BUDGET = 'ORCHESTRA_DOCKER_MEM_BUDGET_BYTES';
export const ENV_DOCKER_MEM_CEILING = 'ORCHESTRA_DOCKER_MEM_CEILING_BYTES';
export const ENV_DOCKER_PIDS_LIMIT = 'ORCHESTRA_DOCKER_PIDS_LIMIT';
export const ENV_DOCKER_NANO_CPUS = 'ORCHESTRA_DOCKER_NANO_CPUS';
export const ENV_DOCKER_HOST_MEM_BUDGET = 'ORCHESTRA_DOCKER_HOST_MEM_BUDGET_BYTES';
export const ENV_DOCKER_HOST_NANO_CPUS = 'ORCHESTRA_DOCKER_HOST_NANO_CPUS';

/** The raise-the-limits setting, in bytes / nano-CPUs (the app resolves `<ORCHESTRA_HOME>/docker-limits.json` into it and freezes it in the spawn frame; see `parseDockerLimitSettings`). */
export interface DockerLimitOverrides {
  memBudgetBytes?: number;
  memCeilingBytes?: number;
  nanoCpus?: number;
  hostMemBudgetBytes?: number;
  hostNanoCpus?: number;
}

function posInt(v: string | number | undefined): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (!v || !/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The member's limits: budget = its memory_cap HARD level (`capHardBytes`, the figure its tool commands are held to), else the host fallback; ceiling = budget;
 * PidsLimit 1024; NanoCpus ceiling = half the host's cores (at least one); host budgets 60 % of RAM / half the cores. Precedence per figure:
 * the ORCHESTRA_DOCKER_* env, then the app's settings (`overrides`), then the derived default.
 */
export function dockerLimitsFor(i: { capHardBytes?: number | null; hostTotalBytes: number; cpus: number; env?: Record<string, string | undefined>; overrides?: DockerLimitOverrides | null }): DockerLimits {
  const env = i.env ?? {};
  const ov = i.overrides ?? {};
  const cap = i.capHardBytes && Number.isFinite(i.capHardBytes) && i.capHardBytes > 0 ? Math.floor(i.capHardBytes) : null;
  const hostFallback = Math.min(HOST_BUDGET_MAX_BYTES, Math.max(HOST_BUDGET_MIN_BYTES, Math.floor(i.hostTotalBytes * HOST_BUDGET_FRACTION)));
  const budgetBytes = posInt(env[ENV_DOCKER_MEM_BUDGET]) ?? posInt(ov.memBudgetBytes) ?? cap ?? hostFallback;
  const memoryCeilingBytes = posInt(env[ENV_DOCKER_MEM_CEILING]) ?? posInt(ov.memCeilingBytes) ?? budgetBytes;
  const cpus = Number.isFinite(i.cpus) && i.cpus >= 1 ? Math.floor(i.cpus) : 1;
  const halfCores = Math.max(1, Math.floor(cpus / 2)) * 1_000_000_000;
  const nanoCpus = posInt(env[ENV_DOCKER_NANO_CPUS]) ?? posInt(ov.nanoCpus) ?? halfCores;
  return {
    memoryCeilingBytes,
    memoryDefaultBytes: Math.max(1, Math.floor(memoryCeilingBytes * DEFAULT_SHARE)),
    budgetBytes,
    pidsLimit: posInt(env[ENV_DOCKER_PIDS_LIMIT]) ?? DEFAULT_PIDS_LIMIT,
    nanoCpus,
    nanoCpusDefault: Math.min(nanoCpus, Math.max(1_000_000_000, Math.floor(nanoCpus * DEFAULT_SHARE))),
    memberCpuBudget: nanoCpus,
    cpuShares: DEFAULT_CPU_SHARES,
    hostMemBudgetBytes: posInt(env[ENV_DOCKER_HOST_MEM_BUDGET]) ?? posInt(ov.hostMemBudgetBytes) ?? Math.floor(i.hostTotalBytes * HOST_MEMORY_SHARE),
    hostCpuBudget: posInt(env[ENV_DOCKER_HOST_NANO_CPUS]) ?? posInt(ov.hostNanoCpus) ?? halfCores,
  };
}

/** `<ORCHESTRA_HOME>/docker-limits.json`: `{ "memBudgetGb": 12, "memCeilingGb": 12, "cpus": 6, "hostMemBudgetGb": 20, "hostCpus": 8, "workspaces": { "<wsId>": { "memBudgetGb": 16, "memCeilingGb": 16, "cpus": 4 } } }` — every key optional; a workspace entry beats the host-wide one. Anything malformed is ignored (the derived default stands). */
export function parseDockerLimitSettings(text: string | null, wsId: string): DockerLimitOverrides {
  if (!text) return {};
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof j !== 'object' || j === null) return {};
  const top = j as Record<string, unknown>;
  const per = typeof top.workspaces === 'object' && top.workspaces !== null ? ((top.workspaces as Record<string, unknown>)[wsId] as Record<string, unknown> | undefined) : undefined;
  const pick = (k: string): number | null => {
    for (const src of [per, top]) {
      const v = src?.[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    }
    return null;
  };
  const out: DockerLimitOverrides = {};
  const mb = pick('memBudgetGb');
  if (mb) out.memBudgetBytes = Math.round(mb * GIB);
  const mc = pick('memCeilingGb');
  if (mc) out.memCeilingBytes = Math.round(mc * GIB);
  const cpus = pick('cpus');
  if (cpus) out.nanoCpus = Math.round(cpus * 1_000_000_000);
  const hm = typeof top.hostMemBudgetGb === 'number' && top.hostMemBudgetGb > 0 ? top.hostMemBudgetGb : null; // host-wide only
  if (hm) out.hostMemBudgetBytes = Math.round(hm * GIB);
  const hc = typeof top.hostCpus === 'number' && top.hostCpus > 0 ? top.hostCpus : null;
  if (hc) out.hostNanoCpus = Math.round(hc * 1_000_000_000);
  return out;
}

/** The raise-the-limits setting file. */
export const dockerLimitsFile = (home: string): string => `${home}/docker-limits.json`;

export const gib = (b: number | bigint): string => `${(Number(b) / GIB).toFixed(2)} GiB`;

/** One container that holds (or is about to hold) resources, as the budgets see it. A figure ≤ 0 = created without that limit (before this relay): it counts as the ceiling. */
export interface BudgetContainer {
  name: string;
  /** The `orchestra.ws` label: whose container it is. */
  ws: string;
  memoryBytes: number;
  nanoCpus: number;
}

/** The states that hold (or are about to hold) resources: a `created` container is counted so a compose that creates five before it starts them cannot slip past. */
export const BUDGET_STATES = ['created', 'running', 'restarting', 'paused'] as const;

export interface BudgetRefusal {
  /** Which budget said no. */
  scope: 'member' | 'host';
  resource: 'memory' | 'cpu';
  inUse: number;
  message: string;
}

const cpuStr = (nano: number): string => `${+(nano / 1e9).toFixed(2)} CPU`;
const memOf = (c: BudgetContainer, l: DockerLimits): number => (c.memoryBytes > 0 ? c.memoryBytes : l.memoryCeilingBytes);
const cpuOf = (c: BudgetContainer, l: DockerLimits): number => (c.nanoCpus > 0 ? c.nanoCpus : l.nanoCpus);

const FREE = 'Free it first: `docker rm -f <name>` (or `docker stop` / `docker compose down`) on the containers above, or create this one with a smaller';

/**
 * null = the create fits. Otherwise the Docker-shaped `message` the member reads: which budget, its size, the in-use sum, the biggest users, what this create asks, how to free it.
 * `all` = every orchestra-labelled container on the daemon (the host-wide view); `ws` = this member's id. Order: member memory, member CPU, host memory, host CPU.
 */
export function budgetRefusal(limits: DockerLimits, ws: string, ask: { memoryBytes: bigint | number; nanoCpus: bigint | number }, all: BudgetContainer[]): BudgetRefusal | null {
  const mine = all.filter((c) => c.ws === ws);
  const askMem = Number(ask.memoryBytes);
  const askCpu = Number(ask.nanoCpus);
  const top = (list: BudgetContainer[], by: (c: BudgetContainer) => number, show: (n: number) => string, withWs: boolean, unlimited: (c: BudgetContainer) => boolean): string =>
    list.length
      ? [...list]
          .sort((a, b) => by(b) - by(a))
          .slice(0, 5)
          .map((c) => `${c.name}${withWs ? ` of ${c.ws}` : ''} (${unlimited(c) ? 'no limit, counted as ' : ''}${show(by(c))})`)
          .join(', ') + (list.length > 5 ? `, … ${list.length - 5} more` : '')
      : 'none';
  const cpuBy = (c: BudgetContainer): number => cpuOf(c, limits);
  const memBy = (c: BudgetContainer): number => memOf(c, limits);
  const checks: Array<{ scope: 'member' | 'host'; resource: 'memory' | 'cpu'; budget: number; used: number; ask: number; list: BudgetContainer[]; by: (c: BudgetContainer) => number; show: (n: number) => string }> = [
    { scope: 'member', resource: 'memory', budget: limits.budgetBytes, used: mine.reduce((s, c) => s + memBy(c), 0), ask: askMem, list: mine, by: memBy, show: gib },
    { scope: 'member', resource: 'cpu', budget: limits.memberCpuBudget, used: mine.reduce((s, c) => s + cpuBy(c), 0), ask: askCpu, list: mine, by: cpuBy, show: cpuStr },
    { scope: 'host', resource: 'memory', budget: limits.hostMemBudgetBytes, used: all.reduce((s, c) => s + memBy(c), 0), ask: askMem, list: all, by: memBy, show: gib },
    { scope: 'host', resource: 'cpu', budget: limits.hostCpuBudget, used: all.reduce((s, c) => s + cpuBy(c), 0), ask: askCpu, list: all, by: cpuBy, show: cpuStr },
  ];
  for (const k of checks) {
    if (k.used + k.ask <= k.budget) continue;
    const who = k.scope === 'member' ? 'this workspace' : 'ALL workspaces together (the host-wide budget)';
    const flag = k.resource === 'memory' ? '`--memory`' : '`--cpus`';
    return {
      scope: k.scope,
      resource: k.resource,
      inUse: k.used,
      message:
        `orchestra docker relay: container ${k.resource} budget exceeded — ${who} may hold ${k.show(k.budget)} of container ${k.resource}, ${k.show(k.used)} is already reserved by ${k.list.length} container(s) [${top(k.list, k.by, k.show, k.scope === 'host', k.resource === 'memory' ? (c) => c.memoryBytes <= 0 : (c) => c.nanoCpus <= 0)}], ` +
        `and this create asks ${k.show(k.ask)}. ${FREE} ${flag}.`,
    };
  }
  return null;
}
