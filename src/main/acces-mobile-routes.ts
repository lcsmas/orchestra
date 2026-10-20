// Accès mobile (#334–#339): the phone's operations in main. Served ONLY on the private channel main hands the phone server at
// spawn (fd 3, shared/acces-mobile-rpc.ts) — never on the hooks socket every local agent can reach: `/mobile/send` speaks with the
// HUMAN's origin (a fleet-pause bypass by decision), so it must be reachable only from the process that checked the Tailscale
// identity + token (#338 review M1).

import { appIdentity, appUpdateState, relaunchApp } from './app-update-host';
import { store } from './store';
import { sdkAnswerAskUserQuestion, sdkInterrupt, sdkListSkills, sdkLiveAnswerables, sdkRewind, sdkRewindPreview, sdkSend, sdkSlashCommands, sdkStopMany } from './agent-sdk';
import { mergeSlashItems, PHONE_EXCLUDED } from '../shared/slash-menu';
import { getMobileConversation, mobileFoldedMessages, noteMobileActivity, subscribeMobileFeed } from './acces-mobile-feed';
import { markWorkspaceSeen } from './mark-seen';
import { archiveWorkspace, dispatchSpawnRequest } from './workspaces';
import { createMobileLauncher } from './acces-mobile-launch';
import { log } from './logger';
import { projectMobileWorkspaces, type MobileWorkspaceRow } from '../shared/acces-mobile';
import { projectMobileRepos } from '../shared/acces-mobile-launch';
import { MOBILE_SEND_MAX_CHARS, parseMobileAttachments, validWorkspaceId } from '../shared/acces-mobile-conversation';
import { createMobileControls } from './acces-mobile-control';
import type { RpcHandlers } from '../shared/acces-mobile-rpc';

function liveWorkspace(id: unknown) {
  const ws = validWorkspaceId(id) ? store.getWorkspace(id) : undefined;
  return ws && !ws.archived ? ws : undefined;
}

/** #340: what a waiting row says — the question it is parked on (live, never a fold); else the status note (default). */
function previewOfLive(ws: { id: string }): MobileWorkspaceRow['preview'] | undefined {
  const live = sdkLiveAnswerables(ws.id);
  if (!live?.length) return undefined;
  const a = live[0];
  if (a.type === 'permission-request' && a.name === 'AskUserQuestion') {
    const q = Array.isArray(a.input?.questions) ? (a.input.questions as { question?: unknown }[])[0] : undefined;
    if (typeof q?.question === 'string') return { kind: 'question', text: q.question };
  }
  if (a.type === 'elicitation-request') return { kind: 'desktop', text: `${a.serverName} : ${a.message}` };
  return { kind: 'desktop', text: a.type === 'permission-request' ? `Permission : ${a.title ?? a.name}` : 'Dialogue à traiter sur le bureau' };
}

/** #375: the phone's launch = the desktop « + » click on a registered repo, the prompt as its first task: human defaults (workspace default
 *  model + effort, the repo's Compte), top-level (no `from`, detached), structured view. `origin: 'human'` — the human's act, like the composer. */
const launcher = createMobileLauncher({
  repos: () => store.repos,
  spawn: ({ repoPath, task }) => dispatchSpawnRequest({ repoPath, task, detached: true, defaultKind: 'workspace', origin: 'human' }),
  info: (line) => log.info(line),
  onCreated: (id) => noteMobileActivity(id), // the entry is created hot even when no stream was open at the answer
});

/** Interrupt + rewind + archive: the desktop's own calls (none takes a pause origin), behind main's guards. */
const controls = createMobileControls({
  liveId: (id) => liveWorkspace(id)?.id,
  fold: mobileFoldedMessages,
  isRunning: (id) => store.getWorkspace(id)?.status === 'running',
  interrupt: sdkInterrupt,
  preview: sdkRewindPreview,
  rewind: sdkRewind,
  // the desktop's archive, verbatim (api-handlers.ts `archiveWorkspace`)
  archive: (id) => {
    sdkStopMany([id]);
    return archiveWorkspace(id);
  },
});

export const mobileRpcHandlers: RpcHandlers = {
  async call(route, msg) {
    switch (route) {
      case '/mobile/workspaces':
        // Every non-archived workspace, every account.
      {
        const update = appUpdateState();
        return {
          ok: true,
          workspaces: projectMobileWorkspaces(store.workspaces, store.repos, store.accounts, previewOfLive),
          app: appIdentity(),
          ...(update.kind === 'installed' ? { appUpdate: { version: update.version } } : {}),
        };
      }
      case '/mobile/repos':
        // The registered repos, every Compte — what the launch form offers (#375).
        return { ok: true, repos: projectMobileRepos(store.repos, store.accounts) };
      case '/mobile/launch':
        // #375: a new workspace from the phone. The shape and the registered repo are decided in the launcher.
        return launcher.launch(msg);
      case '/mobile/conversation': {
        // One workspace's conversation, folded + projected for the phone (account-aware history).
        const ws = liveWorkspace(msg.id);
        return ws ? getMobileConversation(ws.id) : { ok: false, error: 'unknown workspace' };
      }
      case '/mobile/skills': {
        // The composer's `/` menu: the desktop's list (on-disk skills + the CLI's built-ins), minus the desktop-only intercepts.
        const ws = liveWorkspace(msg.id);
        if (!ws) return { ok: false, error: 'unknown workspace' };
        return { ok: true, items: mergeSlashItems(await sdkListSkills(ws.id), sdkSlashCommands(ws.id), ['compact'], PHONE_EXCLUDED) };
      }
      case '/mobile/seen': {
        // The SAME « seen » as the desktop (clears non lu, resolves en attente) — mark-seen.ts.
        const ws = validWorkspaceId(msg.id) ? store.getWorkspace(msg.id) : undefined;
        if (!ws) return { ok: false, error: 'unknown workspace' };
        await markWorkspaceSeen(ws.id);
        return { ok: true };
      }
      case '/mobile/send': {
        // The human typed this on the phone — the SAME call as the desktop composer (origin 'human': queued if mid-turn, wakes a
        // Veille session, allowed while a run is paused). NEVER the agent-to-agent `/message` path.
        const ws = liveWorkspace(msg.id);
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!ws) return { ok: false, error: 'unknown or archived workspace' };
        // Images / PDFs attached on the phone ride the desktop composer's AgentImage path (paste/drop) — validated again here.
        const atts = parseMobileAttachments(msg.attachments);
        if (!atts.ok) return { ok: false, error: atts.error };
        if ((!text && !atts.images.length) || text.length > MOBILE_SEND_MAX_CHARS) return { ok: false, error: `message must be 1–${MOBILE_SEND_MAX_CHARS} characters` };
        try {
          await sdkSend(ws.id, text, atts.images.length ? atts.images : undefined, undefined, undefined, false, false, 'human');
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case '/mobile/answer': {
        // Answer a parked AskUserQuestion — validated, built with the desktop card's builder, refused when already answered.
        const ws = liveWorkspace(msg.id);
        const answers = msg.answers;
        if (!ws) return { ok: false, error: 'unknown or archived workspace' };
        if (typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > 200) return { ok: false, error: 'bad request id' };
        if (!answers || typeof answers !== 'object' || Array.isArray(answers) || !Object.values(answers).every((v) => Array.isArray(v) && v.every((l) => typeof l === 'string')))
          return { ok: false, error: 'answers must map each question to a list of labels' };
        return sdkAnswerAskUserQuestion(ws.id, msg.requestId, answers as Record<string, string[]>);
      }
      case '/mobile/relaunch':
        // « Relancer Orchestra » from the phone: the desktop banner's quit + exec of the installed app, whatever its version. The quit
        // waits 500 ms so this answer reaches the phone first; the phone then waits for a NEW app (`app.startedAt`) to answer.
        return relaunchApp({ requireUpdate: false, quitDelayMs: 500, by: 'phone' });
      case '/mobile/interrupt':
        // The desktop's ■ / Esc — the SAME sdkInterrupt (acces-mobile-control.ts).
        return controls.interrupt(msg);
      case '/mobile/rewind-preview':
        return controls.preview(msg);
      case '/mobile/rewind':
        // The desktop bubble's ↺ — the SAME sdkRewind; target, mid-turn refusal and fallback cut decided in acces-mobile-control.ts.
        return controls.rewind(msg);
      case '/mobile/archive':
        // The sidebar's archive — the SAME calls (acces-mobile-control.ts): an orchestrator takes its subtree, the worktree is kept.
        return controls.archive(msg);
      default:
        return { ok: false, error: 'unknown route' };
    }
  },
  stream(route, push) {
    // Change announcements for the server to relay to the phone.
    if (route !== '/mobile/stream') return null;
    const off = subscribeMobileFeed(push);
    // An immediate ping: the phone treats a stream as healthy (backoff reset, catch-up refetch) only on a REAL message — without
    // it, a phone back from an outage waited for the 25 s keep-alive before refreshing (combined e2e, « rows back »).
    push({ t: 'ping' });
    return off;
  },
};
