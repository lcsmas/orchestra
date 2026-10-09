import { GIB } from '../../shared/memory-guard';
import type { MemberCapView } from '../../shared/member-memory';
import { capTooltip, capUsage } from '../../shared/memory-cap-view';

const pct = (f: number): string => `${(Math.min(1, Math.max(0, f)) * 100).toFixed(1)}%`;

/**
 * #323 (D-Q10 = A): the thin bar under a capped member's MEM figure on the Resources page. Fill = the kernel bill / the hard level the kernel holds for THIS scope; the darker part inside = the working set
 * (`memory.current − inactive_file`, what the soft warning compares); the tick = the soft level. Amber once the working set is at/over the soft level, red once the bill is within 90 % of the hard level
 * (`capUsage` decides — pure, src/shared/memory-cap-view.ts). Rendered only for a member whose scope has a limit applied; the tooltip names both figures with what each is compared to.
 */
export function CapBar({ cap, levels }: { cap: MemberCapView; levels: { softGb: number; hardGb: number } | null }) {
  const u = capUsage(cap, levels ? levels.softGb * GIB : null);
  const tip = capTooltip(cap, levels);
  return (
    <span className={`res-capbar tone-${u.tone}`} role="img" aria-label={`${u.billPct} % of the memory cap`} title={tip} data-res-cap={u.billPct} data-res-cap-tone={u.tone}>
      <i className="res-capbar-fill" style={{ width: pct(u.billFrac) }} />
      {u.workingFrac !== null && <i className="res-capbar-ws" style={{ width: pct(Math.min(u.workingFrac, u.billFrac)) }} />}
      {u.softFrac !== null && <i className="res-capbar-soft" style={{ left: pct(u.softFrac) }} />}
    </span>
  );
}
