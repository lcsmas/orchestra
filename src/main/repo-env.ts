/** Expand a per-repo agent env map against a source environment. Values may use
 * `${VAR}` or `$VAR` to pull from `source`; an entry whose expansion is empty
 * (referenced var unset/blank, or the template was literally empty) is dropped
 * so the spawned agent keeps its default value rather than getting a blank
 * override. Kept dependency-free (no `store`/electron) so it is unit-testable
 * in isolation and cheap to import. */
export function expandRepoEnv(
  raw: Record<string, string> | undefined,
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(raw)) {
    const expanded = template.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_m, braced, bare) => source[braced ?? bare] ?? '',
    );
    if (expanded) out[key] = expanded;
  }
  return out;
}
