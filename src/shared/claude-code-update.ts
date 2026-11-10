// « Mise à jour disponible » (Lucas 2026-11-10, CONTEXT.md): a Claude Code version is published that is newer than the one installed on
// this machine. PURE: the version compare, the state, the words. Monitor: src/main/claude-code-update.ts; host: claude-code-update-host.ts.

export type ClaudeCodeUpdateState =
  | { kind: 'none' }
  | { kind: 'available'; installed: string; published: string }
  /** `claude update` is running (started from the notice). */
  | { kind: 'running'; installed: string; published: string }
  /** The update started from the notice succeeded; shown until the human closes it. */
  | { kind: 'installed'; from: string; version: string }
  /** The update started from the notice did not install anything; `error` = what the command said. */
  | { kind: 'failed'; installed: string; published: string; error: string };

export const CLAUDE_CODE_UPDATE_NONE: ClaudeCodeUpdateState = { kind: 'none' };

/** `2.1.322` → [2, 1, 322]; anything else (an HTML error page, a pre-release tag, empty) → null. */
function versionParts(v: string | null | undefined): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only when both are versions and `a` is strictly newer than `b`. */
export function isNewerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = versionParts(a), y = versionParts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** An unknown side (no `claude` on PATH, the network did not answer) never announces anything. */
export function decideClaudeCodeUpdate(installed: string | null, published: string | null): ClaudeCodeUpdateState {
  if (!installed || !published || !isNewerVersion(published, installed)) return CLAUDE_CODE_UPDATE_NONE;
  return { kind: 'available', installed, published: published.trim() };
}

/** Two states with the same key are the same notice: nothing is pushed. */
export function claudeCodeUpdateStateKey(s: ClaudeCodeUpdateState): string {
  return JSON.stringify(s);
}

/** How a `claude update` run ended. `code` null = it could not be started, or was killed. */
export interface UpdateRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const FAILURE_TEXT_MAX = 600;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** What the notice shows for a run that installed nothing: the command's own words — its stderr as printed, else all it wrote —
 *  never a rewording (the cause is in there). Bounded to its END (where the cause is), terminal colour codes removed. */
export function updateFailureText(r: UpdateRunResult): string {
  const clean = (t: string) => String(t ?? '').replace(ANSI, '').trim();
  const said = clean(r.stderr) || clean(r.stdout);
  if (said) return said.slice(-FAILURE_TEXT_MAX);
  return r.code === null ? 'claude update n’a pas pu être lancé' : `claude update a échoué (code ${r.code})`;
}

/** The notice in words (the sidebar strip + its popover). `action`: what the one button does — `update` runs `claude update`
 *  (« Mettre à jour » / « Réessayer »), `ack` closes « installé ». There is no « Plus tard »: the strip stays while an update exists. */
export interface ClaudeCodeUpdateCopy {
  tone: 'info' | 'ok' | 'error';
  icon: string;
  strip: string;
  title: string;
  installed: string;
  /** '' = no « Publiée » row (once installed there is nothing left to compare). */
  published: string;
  note: string;
  error: string;
  action: 'update' | 'ack';
  actionLabel: string;
  busy: boolean;
}

export function claudeCodeUpdateCopy(s: ClaudeCodeUpdateState): ClaudeCodeUpdateCopy | null {
  switch (s.kind) {
    case 'none':
      return null;
    case 'available':
      return {
        tone: 'info',
        icon: '↑',
        strip: `Claude Code ${s.published} disponible`,
        title: 'Mise à jour de Claude Code disponible',
        installed: s.installed,
        published: s.published,
        note: `Les sessions en cours ne sont pas redémarrées : elles passent à ${s.published} à leur prochain démarrage.`,
        error: '',
        action: 'update',
        actionLabel: 'Mettre à jour',
        busy: false,
      };
    case 'running':
      return {
        tone: 'info',
        icon: '↻',
        strip: 'Mise à jour de Claude Code…',
        title: 'Mise à jour de Claude Code…',
        installed: s.installed,
        published: s.published,
        note: 'Les agents continuent pendant l’installation.',
        error: '',
        action: 'update',
        actionLabel: 'Mise à jour…',
        busy: true,
      };
    case 'installed':
      return {
        tone: 'ok',
        icon: '✓',
        strip: `Claude Code ${s.version} installé`,
        title: `Claude Code ${s.version} installé`,
        installed: s.version,
        published: '',
        note: `Les nouvelles sessions l’utilisent ; celles en cours gardent ${s.from} jusqu’à leur prochain démarrage.`,
        error: '',
        action: 'ack',
        actionLabel: 'OK',
        busy: false,
      };
    case 'failed':
      return {
        tone: 'error',
        icon: '!',
        strip: 'Mise à jour impossible',
        title: 'Mise à jour de Claude Code impossible',
        installed: s.installed,
        published: s.published,
        note: '',
        error: s.error,
        action: 'update',
        actionLabel: 'Réessayer',
        busy: false,
      };
  }
}

/** Where the native installer and `claude update` read the published version: `<base>/<channel>` answers a bare `2.1.322`. */
export const CLAUDE_CODE_RELEASES_URL = 'https://downloads.claude.ai/claude-code-releases';
export type UpdateChannel = 'latest' | 'stable';

/** The channel `claude update` follows: `autoUpdatesChannel` of the settings.json it reads, `latest` when unset (measured on 2.1.310:
 *  with `stable` it installs the stable version). The notice must announce what the button would install. */
export function updateChannel(settingsJson: string | null): UpdateChannel {
  try {
    return (JSON.parse(settingsJson ?? '') as { autoUpdatesChannel?: unknown })?.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';
  } catch {
    return 'latest';
  }
}

export function publishedVersionUrl(base: string, channel: UpdateChannel): string {
  return `${base.replace(/\/+$/, '')}/${channel}`;
}

/** The body of a channel URL → the version, or null for anything else (an HTML error page from a proxy, an empty answer). */
export function parsePublishedVersion(body: string): string | null {
  const v = String(body ?? '').trim();
  return versionParts(v) ? v : null;
}
