// Browser tab memory — the producer half of #394 (pure attribution: shared/browser-tab-memory.ts). Electron-free on purpose: the
// samplers (resources.ts, resource-monitor.ts, hooks-server.ts) import this, and their unit tests run under plain node.
// browser-panel.ts registers the SOURCE (its tabs and their renderer pids) at init.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { attributeBrowserTabMemory, type BrowserTabMemoryView, type BrowserTabProc } from '../shared/browser-tab-memory.ts';
import { parseProcStatLine, parsePsOutput, type ProcSample } from '../shared/resources.ts';
import { hostPageSize } from './host-page-size.ts';

export interface BrowserTabSource {
  /** Every live tab of every workspace with its renderer's OS pid (null = no live webContents / pid not started). */
  tabs(): BrowserTabProc[];
  /** Renderer pids that also host a page that is NOT a workspace tab (Orchestra's own UI): never billed to a workspace. */
  nonTabPids(): number[];
}

let source: BrowserTabSource | null = null;
let warned = false;

export function setBrowserTabSource(s: BrowserTabSource | null): void {
  source = s;
  warned = false;
}

/** Just these pids' /proc stats (Linux) or one `ps -p` (elsewhere) — what the bus-status read needs without scanning the whole table. */
export function readPidTable(pids: readonly number[]): ProcSample[] {
  const out: ProcSample[] = [];
  if (pids.length === 0) return out;
  if (process.platform === 'linux') {
    const pageSize = hostPageSize();
    for (const pid of pids) {
      try {
        const p = parseProcStatLine(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), pageSize);
        if (p) out.push(p);
      } catch {
        /* exited — absent from the table reads « not measured » */
      }
    }
    return out;
  }
  try {
    return parsePsOutput(execFileSync('ps', ['-o', 'pid=,ppid=,rss=,pcpu=,comm=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2000 }));
  } catch {
    return out;
  }
}

function measure(src: BrowserTabSource, tableOf: (tabPids: number[]) => readonly ProcSample[]): BrowserTabMemoryView {
  const tabs = src.tabs();
  const mem = new Map<number, number>();
  for (const p of tableOf([...new Set(tabs.flatMap((t) => (t.pid !== null && t.pid > 0 ? [t.pid] : [])))])) mem.set(p.pid, p.memBytes);
  return attributeBrowserTabMemory(tabs, mem, new Set(src.nonTabPids()));
}

/**
 * The browser footprint per workspace, measured against `table` — the process table the CALLER just read (RSS, the same unit and page-size
 * handling as every other figure on the page; `app.getAppMetrics()` is not asked, so its process-wide CPU cursor is never reset).
 * `undefined` = not measurable (no source registered: a rig or a test; or the source threw) — never an empty view, so « no tabs » and
 * « could not look » stay different. Never throws.
 */
export function sampleBrowserTabMemory(table: readonly ProcSample[], src: BrowserTabSource | null = source, warn: (msg: string, e: unknown) => void = () => {}): BrowserTabMemoryView | undefined {
  return guarded(src, warn, (s) => measure(s, () => table));
}

/** Same figure from a read of just the tabs' own pids (`bus-status`: no full-table scan). */
export function currentBrowserTabMemory(src: BrowserTabSource | null = source, warn: (msg: string, e: unknown) => void = () => {}, tableOf: (pids: number[]) => readonly ProcSample[] = readPidTable): BrowserTabMemoryView | undefined {
  return guarded(src, warn, (s) => measure(s, tableOf));
}

function guarded(src: BrowserTabSource | null, warn: (msg: string, e: unknown) => void, f: (s: BrowserTabSource) => BrowserTabMemoryView): BrowserTabMemoryView | undefined {
  if (!src) return undefined;
  try {
    return f(src);
  } catch (e) {
    if (!warned) {
      warned = true;
      warn('resources: browser tab memory could not be read — rows carry no browser figure', e);
    }
    return undefined;
  }
}
