import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// External-tool dependency probe (git / gh / claude). Extracted from index.ts
// so the same check backs BOTH the Electron startup warning dialog and the
// ui-rpc `deps:status` method (a GTK frontend renders its own dialog from
// this result — docs/ui-rpc-protocol.md §4).

const pExecFile = promisify(execFile);

/** What the probe found. `messages` carries one human-readable install blurb
 *  per missing tool (empty when everything is present) — the exact text the
 *  Electron dialog has always shown, so frontends need no copy of their own. */
export interface DepsStatus {
  git: boolean;
  gh: boolean;
  claude: boolean;
  messages: string[];
}

async function checkCommand(cmd: string): Promise<boolean> {
  try {
    await pExecFile('command', ['-v', cmd], { shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

/** Probe all three tools in parallel (this sits on the boot path — serial
 *  subshell spawns are real wall time the user waits at a blank screen). */
export async function probeDependencies(): Promise<DepsStatus> {
  const [git, gh, claude] = await Promise.all([
    checkCommand('git'),
    checkCommand('gh'),
    checkCommand('claude'),
  ]);
  const messages: string[] = [];
  if (!git) {
    messages.push(
      '❌ git\n   Git version control\n   Install:\n   Fedora: sudo dnf install git\nUbuntu: sudo apt install git',
    );
  }
  if (!gh) {
    messages.push(
      '❌ gh\n   GitHub CLI (for PR creation)\n   Install:\n   Fedora: sudo dnf install gh\nUbuntu: sudo apt install gh\nOr: https://cli.github.com/',
    );
  }
  if (!claude) {
    messages.push(
      '❌ claude\n   Claude Code CLI\n   Install:\n   npm install -g @anthropic-ai/claude-code\nOr: https://docs.anthropic.com/claude-code',
    );
  }
  return { git, gh, claude, messages };
}
