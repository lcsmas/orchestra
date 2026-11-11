// Vague endormie (#428) — what survives a restart, on disk: `<ORCHESTRA_HOME>/vague-endormie.json`, written atomically (tmp + rename). Electron-free: driven by node --test on a scratch dir.
import fs from 'node:fs';
import path from 'node:path';
import type { PersistedVagues, VagueStore } from './vague-endormie.ts';

export function createVagueFileStore(file: () => string): VagueStore {
  return {
    load(): PersistedVagues {
      let raw: string;
      try {
        raw = fs.readFileSync(file(), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; // first run (or first run after the upgrade): nothing known
        throw e;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('vague-endormie.json: not an object');
      return parsed as PersistedVagues;
    },
    save(all: PersistedVagues): void {
      const f = file();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, f);
    },
  };
}
