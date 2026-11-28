// What `orchestra delete` and the host's orphan sweep report about a workspace's Docker containers (#696). Pure: the I/O half is src/main/docker-cleanup.ts.

/** A volume the daemon named itself (`docker run -v /var/lib/mysql`, an image's VOLUME): 64 hex chars. `rm -v` takes exactly these; anything else was named by a human or a compose file. */
export function isAnonymousVolumeName(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

export interface RemovedContainer {
  id: string;
  name: string;
  image: string;
  /** Anonymous volumes the removal took with the container (`rm -v`). */
  anonymousVolumes: number;
  /** Named volumes the container mounted: kept unless removal was asked (then see `removedNamedVolumes`). */
  namedVolumes: string[];
}

export interface DockerCleanupReport {
  /** No daemon answered: nothing was looked at (not "no containers"). */
  unavailable: boolean;
  removed: RemovedContainer[];
  /** Containers that could not be removed: `<name>: <why>`. */
  failed: string[];
  /** Named volumes removed because the caller asked (`--volumes`). */
  removedNamedVolumes: string[];
  /** Named volumes still there: not asked, or another container uses them (the daemon refuses). `<volume> (<why>)`. */
  keptNamedVolumes: string[];
  /** Why the list itself failed (the daemon answered an error). */
  error?: string;
}

export function emptyCleanupReport(): DockerCleanupReport {
  return { unavailable: false, removed: [], failed: [], removedNamedVolumes: [], keptNamedVolumes: [] };
}

/** True when the report has something a human should read. */
export function cleanupReportIsNoteworthy(r: DockerCleanupReport): boolean {
  return r.removed.length > 0 || r.failed.length > 0 || r.keptNamedVolumes.length > 0 || r.removedNamedVolumes.length > 0 || !!r.error;
}

/** The lines `orchestra delete` prints under "Deleted workspace …". Empty when there was nothing Docker-side to say. */
export function formatCleanupReport(r: DockerCleanupReport): string[] {
  const out: string[] = [];
  if (r.removed.length > 0) {
    out.push(`Removed ${r.removed.length} Docker container${r.removed.length === 1 ? '' : 's'}:`);
    for (const c of r.removed) out.push(`  ${c.name || c.id.slice(0, 12)} (${c.image || 'unknown image'}) — ${c.anonymousVolumes} anonymous volume${c.anonymousVolumes === 1 ? '' : 's'}`);
  }
  if (r.removedNamedVolumes.length > 0) out.push(`Removed named volume${r.removedNamedVolumes.length === 1 ? '' : 's'}: ${r.removedNamedVolumes.join(', ')}`);
  if (r.keptNamedVolumes.length > 0) out.push(`Named volume${r.keptNamedVolumes.length === 1 ? '' : 's'} kept (re-run with --volumes to remove): ${r.keptNamedVolumes.join(', ')}`);
  for (const f of r.failed) out.push(`Could not remove container ${f}`);
  if (r.error) out.push(`Docker: ${r.error}`);
  return out;
}

/** The sweep's one log line per removed container. */
export function sweepLogLine(c: RemovedContainer, wsId: string): string {
  const named = c.namedVolumes.length > 0 ? `; named volumes kept: ${c.namedVolumes.join(', ')}` : '';
  return `docker-sweep: removed container ${c.name || c.id.slice(0, 12)} (${c.id.slice(0, 12)}, ${c.image || 'unknown image'}) of deleted workspace ${wsId} — ${c.anonymousVolumes} anonymous volume(s) removed${named}`;
}
