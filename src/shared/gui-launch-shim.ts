/**
 * Agent-PATH shims for the commands that start the user's DESKTOP browser. An agent's env carries its workspace
 * TMPDIR, which Orchestra deletes with the workspace; a Chromium started from it keeps its SingletonSocket there,
 * so once the workspace is gone every later launch becomes a 2nd instance on the same profile ("Something went
 * wrong when opening your profile"). The shim re-execs the real binary without TMPDIR (and CHROME_DESKTOP) for a
 * launch on the user's real profile; a scratch/headless launch (`--user-data-dir`, `--headless`) is left untouched.
 */
export const GUI_LAUNCH_SHIM_NAMES = ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable', 'xdg-open'] as const;

export function guiLaunchShimBody(name: string, shimDir: string, marker: string): string {
  const scratchCheck = name === 'xdg-open'
    ? []
    : ['for a in "$@"; do', '  case "$a" in --user-data-dir=*|--user-data-dir|--headless|--headless=*) exec "$real" "$@" ;; esac', 'done'];
  return [
    '#!/bin/sh',
    `# ${marker}. Safe to delete.`,
    '# Starts the desktop app outside the agent workspace TMPDIR (deleted with the workspace).',
    `self_dir='${shimDir.replace(/'/g, `'\\''`)}'`,
    'real=""',
    'IFS_OLD=$IFS; IFS=:',
    `for d in $PATH; do [ "$d" = "$self_dir" ] && continue; [ -x "$d/${name}" ] && { real="$d/${name}"; break; }; done`,
    'IFS=$IFS_OLD',
    `[ -n "$real" ] || { echo "${name}: not found outside $self_dir" >&2; exit 127; }`,
    ...scratchCheck,
    'exec env -u TMPDIR -u CHROME_DESKTOP "$real" "$@"',
    '',
  ].join('\n');
}
