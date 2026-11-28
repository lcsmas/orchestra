// #695 — a capped container that hits its limit is OOM-killed (exit 137): the daemon says so on its event stream (`oom`). The relay's keeper listens for the member's containers
// and turns each event into the same notice the Plafond mémoire raises (the member's row + the coordinator's escalation). Pure half: the filter, the line parser, the record.

import { DOCKER_LABEL_WS } from './docker-labels.ts';
import type { MemKillRecord } from './memory-scope.ts';

/** `GET <prefix>/events?filters=…`: container `oom` events of THIS workspace's containers. */
export function oomEventsPath(ws: string): string {
  return `/events?filters=${encodeURIComponent(JSON.stringify({ type: ['container'], event: ['oom'], label: [`${DOCKER_LABEL_WS}=${ws}`] }))}`;
}

export interface OomEvent {
  id: string;
  name: string;
  at: number;
}

/** One line of the event stream → an oom event of a container, or null (any other event, a torn line). */
export function parseOomEventLine(line: string): OomEvent | null {
  let j: { Type?: string; Action?: string; status?: string; id?: string; Actor?: { ID?: string; Attributes?: Record<string, string> }; time?: number; timeNano?: number };
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if ((j.Type ?? 'container') !== 'container' || (j.Action ?? j.status) !== 'oom') return null;
  const id = j.Actor?.ID ?? j.id;
  if (!id) return null;
  const name = j.Actor?.Attributes?.name ?? id.slice(0, 12);
  const at = typeof j.timeNano === 'number' ? Math.round(j.timeNano / 1e6) : typeof j.time === 'number' ? j.time * 1000 : Date.now();
  return { id, name, at };
}

/** The kill record of one container OOM: `(unit, seq)` is its identity on the host (one row / one bus message per event). */
export function dockerOomRecord(ws: string, seq: number, ev: OomEvent, limitBytes: number | null): MemKillRecord {
  return {
    kind: 'kill',
    source: 'kernel',
    seq,
    at: ev.at,
    level: 'hard',
    container: { name: ev.name, limitBytes },
    command: `container ${ev.name}`,
    pid: null,
    rssBytes: null,
    candidates: [],
    unit: `docker:${ws}`,
    hardBytes: limitBytes,
  };
}
