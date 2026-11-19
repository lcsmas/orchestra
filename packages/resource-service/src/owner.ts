// Who is the coordinator of a run. A1: a numeric pid → its identity (pid + starttime). A6 adds `auto` (the nearest `claude` ancestor).
import { refused, usageError } from './errors.ts';
import { identityOf, type Identity } from './proc.ts';

export async function resolveOwner(spec: string | undefined): Promise<Identity> {
  if (spec === undefined) throw usageError('--owner <pid> is required');
  if (!/^\d+$/.test(spec)) throw usageError(`--owner expects a pid, got ${JSON.stringify(spec)}`);
  const pid = Number(spec);
  if (pid <= 1) throw usageError(`--owner ${pid}: refusing pid <= 1 (it would never die)`);
  const id = identityOf(pid);
  if (!id) throw refused(`--owner ${pid}: no such running process`);
  return id;
}
