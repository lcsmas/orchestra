/** Pure helpers for "which Claude Code runtime is this session on vs. the one
 *  on PATH now". A live session keeps the CLI binary it was spawned from (the
 *  keeper even survives app restarts), so after `claude update` its
 *  `supportedModels()` is a FROZEN list — the picker must follow PATH instead. */

/** `claude --version` stdout (`2.1.280 (Claude Code)`) → `2.1.280`, else null. */
export function parseCliVersion(stdout: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(stdout ?? '');
  return m ? m[1] : null;
}

/** True only when BOTH versions are known and differ — an unknown side is never
 *  called stale (callers then fall back to the pre-existing behaviour). */
export function isRuntimeStale(sessionVersion: string | undefined | null, currentVersion: string | undefined | null): boolean {
  return !!sessionVersion && !!currentVersion && sessionVersion !== currentVersion;
}

/** Strip a context suffix: `claude-opus-5-5[1m]` → `claude-opus-5-5`. */
function baseId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').trim();
}

type ModelRow = { value: string; resolvedModel?: string };

/** The concrete model a runtime's list maps `model` to (by value or resolved
 *  id, `[1m]` ignored), or null when the list doesn't offer it. */
export function resolveIn(models: ModelRow[], model: string): string | null {
  const want = baseId(model);
  const row = models.find(
    (m) => baseId(m.value) === want || (m.resolvedModel ? baseId(m.resolvedModel) === want : false),
  );
  return row ? baseId(row.resolvedModel ?? row.value) : null;
}

/** Can the runtime with list `own` serve `model` the way the CURRENT runtime
 *  (`current`) would? False when own lacks it OR resolves the same alias to an
 *  older model (2.1.278 `opus[1m]` → claude-opus-5, 2.1.280 → claude-opus-5-5). */
export function runtimeServesLikeCurrent(own: ModelRow[], current: ModelRow[], model: string): boolean {
  if (!baseId(model)) return true; // "account default" — every runtime has one
  const target = resolveIn(current, model);
  if (target === null) return true; // current doesn't know it either: restarting can't help
  return resolveIn(own, model) === target;
}
