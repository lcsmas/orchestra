import fs from 'node:fs';
import path from 'node:path';
import {
  parseBrowserTabsFile,
  serializeBrowserTabsFile,
  type PersistedBrowserTabs,
} from '../shared/browser-tab-state.ts';

// The on-disk half of "tabs come back after a restart" (#393): <userData>/orchestra/browser-tabs.json, one entry per workspace
// (each tab's URL + opener, which one was active). A SEPARATE small file rather than store.json: a navigation rewrites it (debounced),
// and the panel module that feeds it must stay loadable without the workspace store (the browser-panel verify harnesses stub only
// electron/platform/logger). Reads are lazy and tolerant (a corrupt file is a fresh start); writes are tmp + rename.

export interface BrowserTabsPersistence {
  /** The persisted tabs of `wsId`, or null when none were saved. */
  load(wsId: string): PersistedBrowserTabs | null;
  /** Record `wsId`'s tabs (null = forget them: workspace deleted / archived). Coalesced; reaches disk after the debounce or on {@link flush}. */
  save(wsId: string, tabs: PersistedBrowserTabs | null): void;
  /** Write any pending change now (app quit). */
  flush(): void;
}

const DEBOUNCE_MS = 400;

export function createBrowserTabsStore(opts: { file: string | (() => string); warn?: (msg: string, err?: unknown) => void }): BrowserTabsPersistence {
  const warn = opts.warn ?? (() => {});
  // Resolved at first use: index.ts builds the store at module scope, before Electron's userData path is settled.
  const fileOf = (): string => (typeof opts.file === 'function' ? opts.file() : opts.file);
  let cache: Record<string, PersistedBrowserTabs> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let dirty = false;

  const read = (): Record<string, PersistedBrowserTabs> => {
    if (cache) return cache;
    try {
      cache = parseBrowserTabsFile(fs.readFileSync(fileOf(), 'utf8'));
    } catch (err) {
      // ENOENT (ENOTDIR: the parent is not a directory yet) is the normal first run; anything else is worth a line but never a boot failure.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') warn(`browser-tabs: cannot read ${fileOf()} — starting empty`, err);
      cache = {};
    }
    return cache;
  };

  const write = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    dirty = false;
    const file = fileOf();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, serializeBrowserTabsFile(read()));
      fs.renameSync(tmp, file);
    } catch (err) {
      dirty = true; // keep it pending: the next save / flush retries
      warn(`browser-tabs: cannot write ${file}`, err);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    }
  };

  return {
    load: (wsId) => read()[wsId] ?? null,
    save(wsId, tabs) {
      const all = read();
      if (tabs === null ? !(wsId in all) : JSON.stringify(all[wsId]) === JSON.stringify(tabs)) return;
      if (tabs === null) delete all[wsId];
      else all[wsId] = tabs;
      dirty = true;
      if (!timer) {
        timer = setTimeout(write, DEBOUNCE_MS);
        timer.unref?.();
      }
    },
    flush: write,
  };
}
