// #612 (spec #601, spike #602) — the pure half of the NO-AGENT workspace: a workspace whose RUN COMMAND (not an agent) owns a fan-out run.
// The host starts the command DETACHED (`setsid`), mints + registers its session key (so `/identity` vouches it as the run's coordinator) and
// vouches it again after an app restart (the key hash persists in session-keys.json). Node-only wiring: src/main/noagent.ts.
import { childEnv } from './child-env.ts';

/** The env a no-agent command is NEVER allowed to inherit from the app's own env (an app started from an agent shell would hand over ITS identity). */
const IDENTITY_ENV = ['ORCHESTRA_EVENTS_DIR', 'ORCHESTRA_SOCK', 'ORCHESTRA_WS_ID', 'ORCHESTRA_WS_ID_IDENTITY', 'ORCHESTRA_SESSION_KEY', 'ORCHESTRA_RUN_ID'] as const;

/** Refusal names (`[name] …`). */
export const NOAGENT_REFUSALS = ['noagent-no-display', 'noagent-not-noagent', 'noagent-no-command', 'noagent-bad-command'] as const;
export type NoAgentRefusalName = (typeof NOAGENT_REFUSALS)[number];

export function noAgentRefusal(name: NoAgentRefusalName, text: string): string {
  return `[${name}] ${text}`;
}

/** The longest run command accepted: one printable shell command, not a script file's worth. */
export const RUN_COMMAND_MAX = 2000;

/** `orchestra spawn --no-agent --run-command <cmd>`: the command checked BEFORE anything is created. null = fine. */
export function runCommandRefusal(cmd: string | undefined | null): string | null {
  const c = (cmd ?? '').trim();
  if (!c) return noAgentRefusal('noagent-no-command', '`--no-agent` needs `--run-command "<cmd>"`: the command that owns the run (a workspace with no agent and no command would do nothing). Nothing was created.');
  if (c.length > RUN_COMMAND_MAX || /\0/.test(c)) return noAgentRefusal('noagent-bad-command', `the run command must be one shell command of at most ${RUN_COMMAND_MAX} characters, with no NUL. Nothing was created.`);
  return null;
}

/**
 * A host with no display cannot run Orchestra at all (measured, #602: Electron aborts with `Gtk-ERROR … without a display connection` before any of our code runs, also with the headless ozone hint).
 * So the refusal lives where we still can: the CLI's `spawn --no-agent` preflight (the app is not answering AND no display is in the env) and the host route (a display-less env that somehow got this far).
 * Linux only: macOS / Windows always have a window server for a GUI process.
 */
export function noDisplayRefusal(env: Record<string, string | undefined>, platform: string = process.platform): string | null {
  if (platform !== 'linux') return null;
  if ((env.DISPLAY ?? '').trim() || (env.WAYLAND_DISPLAY ?? '').trim()) return null;
  return noAgentRefusal('noagent-no-display', 'this host has no display (neither DISPLAY nor WAYLAND_DISPLAY is set): Orchestra is an Electron app and cannot run without one — start it under a virtual display (e.g. `xvfb-run orchestra`, or a headless sway), then spawn again. Nothing was created.');
}

/** The env of the detached command: the app's env (minus its child-only vars and any inherited identity) + the workspace's script env + the identity the HOST vouches. */
export function noAgentCommandEnv(i: { base: Record<string, string | undefined>; scriptEnv: Record<string, string>; sock: string; wsId: string; key: string; runId: string }): Record<string, string> {
  const env = childEnv(i.base);
  for (const k of IDENTITY_ENV) delete env[k];
  return { ...env, ...i.scriptEnv, ORCHESTRA_SOCK: i.sock, ORCHESTRA_WS_ID: i.wsId, ORCHESTRA_SESSION_KEY: i.key, ORCHESTRA_RUN_ID: i.runId };
}

/** What the host keeps per no-agent command to know, across an app restart, that it is the SAME process (pid reuse never counts). */
export interface NoAgentRecord {
  version: 1;
  pid: number;
  /** Clock ticks since boot at which `pid` started (`/proc/<pid>/stat` field 22); null = unreadable (macOS: pid probe only). */
  startTicks: number | null;
  startedAt: string;
  command: string;
}

/** Field 22 of `/proc/<pid>/stat` (the comm field may hold spaces and parens: split after the LAST `)`); null when malformed. Field 3 `Z` (zombie) reads as null too: a zombie is dead. */
export function parseProcStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 2).split(' '); // rest[0] = field 3 (state)
  if (rest[0] === 'Z' || rest[0] === 'X') return null;
  const ticks = Number(rest[19]); // field 22 = rest[22 - 3]
  return Number.isInteger(ticks) && ticks >= 0 ? ticks : null;
}

export function parseNoAgentRecord(raw: string): NoAgentRecord | null {
  try {
    const r = JSON.parse(raw) as Partial<NoAgentRecord>;
    if (r.version !== 1 || !Number.isInteger(r.pid) || (r.pid as number) <= 1) return null;
    if (r.startTicks !== null && !Number.isInteger(r.startTicks)) return null;
    return { version: 1, pid: r.pid as number, startTicks: r.startTicks ?? null, startedAt: String(r.startedAt ?? ''), command: String(r.command ?? '') };
  } catch {
    return null;
  }
}

/** Is the recorded command still THE SAME live process? `ticksNow` = `parseProcStartTicks` of the pid's stat now (null = gone / zombie / unreadable). With no recorded ticks (no /proc) the pid probe alone decides. */
export function recordIsAlive(rec: NoAgentRecord, ticksNow: number | null, pidProbe: boolean): boolean {
  if (rec.startTicks === null) return pidProbe;
  return ticksNow !== null && ticksNow === rec.startTicks;
}
