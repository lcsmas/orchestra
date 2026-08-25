/** Resolving the skill dirs contributed by a config dir's ENABLED plugins.
 *
 *  Split out of `agent-sdk.ts` so it is testable without Electron (that module
 *  imports the platform seam, which the node test runner cannot resolve). The
 *  functions here are PURE: they take already-parsed file contents and return
 *  paths, so a test can exercise the precedence and namespacing rules without
 *  building a plugin tree on disk. The actual reads live in agent-sdk.ts.
 */

/** `settings.json`'s plugin gate: `{"<plugin>@<marketplace>": true}`. */
export interface PluginSettings {
  enabledPlugins?: Record<string, boolean>;
}

/** `plugins/installed_plugins.json`: each key holds one record per install
 *  scope (user/project), all pointing at the same versioned installPath. */
export interface InstalledPlugins {
  plugins?: Record<string, { installPath?: string }[]>;
}

/** A plugin's `.claude-plugin/plugin.json`, of which we need only the explicit
 *  skill list — the tree also carries deprecated/in-progress dirs the CLI does
 *  NOT load, so the manifest is the source of truth, never a dir walk. */
export interface PluginManifest {
  skills?: unknown;
}

/** The install path for each ENABLED plugin, as `{key, pluginName, installPath}`.
 *  A plugin installed but not enabled in settings.json is omitted, so the
 *  composer's menu matches what the runtime will actually accept. */
export function enabledPluginInstalls(
  settings: PluginSettings | null,
  installed: InstalledPlugins | null,
): { key: string; pluginName: string; installPath: string }[] {
  if (!settings || !installed) return [];
  const out: { key: string; pluginName: string; installPath: string }[] = [];
  for (const [key, on] of Object.entries(settings.enabledPlugins ?? {})) {
    if (on !== true) continue;
    const pluginName = key.split('@')[0];
    const installPath = (installed.plugins?.[key] ?? []).find((r) => r.installPath)?.installPath;
    if (!pluginName || !installPath) continue;
    out.push({ key, pluginName, installPath });
  }
  return out;
}

/** The relative skill dirs a manifest declares (`[]` when malformed/absent).
 *
 *  NOT every plugin declares them: of the two installed here, mattpocock-skills
 *  lists 25 explicit paths (its tree ALSO holds deprecated/ and in-progress/
 *  dirs the CLI does not load, so the manifest is what to trust), while the
 *  slack plugin has no `skills` key at all and relies on the conventional
 *  `skills/*` dir. A manifest-only reader silently misses the entire second
 *  plugin — hence {@link pluginSkillRoots}. */
export function manifestSkillPaths(manifest: PluginManifest | null): string[] {
  if (!manifest || !Array.isArray(manifest.skills)) return [];
  return manifest.skills.filter((s): s is string => typeof s === 'string');
}

/** How to enumerate one plugin's skills: either the explicit relative paths
 *  from its manifest, or — when it declares none — a scan of its conventional
 *  `skills/` dir. The caller does the readdir for the `scan` case, since this
 *  module stays pure. */
export type PluginSkillSource =
  | { mode: 'manifest'; rels: string[] }
  | { mode: 'scan'; dir: string };

/** Decide which enumeration applies to a plugin. Manifest wins when present
 *  and non-empty; otherwise fall back to scanning `<installPath>/skills`. */
export function pluginSkillRoots(
  installPath: string,
  manifest: PluginManifest | null,
  joinPath: (...parts: string[]) => string,
): PluginSkillSource {
  const rels = manifestSkillPaths(manifest);
  if (rels.length > 0) return { mode: 'manifest', rels };
  return { mode: 'scan', dir: joinPath(installPath, 'skills') };
}

/** The CLI's namespaced invocation name for a plugin skill: `<plugin>:<skill>`.
 *  This MUST match what `session/init` reports in `slash_commands`, otherwise
 *  the composer lists the same skill twice — once from the disk scan and once
 *  from the session — since its dedup is keyed on the name. */
export function pluginSkillName(pluginName: string, skillDirName: string): string {
  return `${pluginName}:${skillDirName}`;
}

/** First sentence of a frontmatter `description` value, with YAML quoting
 *  stripped. Split out of agent-sdk.ts's file reader so the parsing rule is
 *  testable on its own: plugin frontmatter routinely QUOTES the description
 *  (mandatory when the text contains a colon), and without stripping, the
 *  composer popover renders a stray leading `"`. */
export function firstSentenceOfDescription(rawValue: string): string {
  const unquoted = rawValue.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  return unquoted.trim().split(/(?<=\.)\s/)[0].slice(0, 140);
}
