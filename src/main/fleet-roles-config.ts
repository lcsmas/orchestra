// #465: the optional per-role override `<ORCHESTRA_HOME>/fleet-roles.json`, read at each agent spawn (no cache: an edit applies to the next spawn).
// Absent file = no override. A file that does not parse STRICTLY throws a named error — the spawn is refused, never half-applied.
import fs from 'node:fs';
import path from 'node:path';
import { parseRoleConfig, ROLE_CONFIG_FILE, type RoleConfig } from '../shared/fleet-roles.ts';
import { orchestraHome } from './platform/index.ts';

export function loadRoleConfig(home: string = orchestraHome()): RoleConfig {
  const file = path.join(home, ROLE_CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  try {
    return parseRoleConfig(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}
