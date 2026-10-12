// Accès mobile (#334–#339): the phone's operations in main. Served ONLY on the private channel main hands the phone server at
// spawn (fd 3, shared/acces-mobile-rpc.ts) — never on the hooks socket every local agent can reach: `/mobile/send` speaks with the
// HUMAN's origin (a fleet-pause bypass by decision), so it must be reachable only from the process that checked the Tailscale
// identity + token (#338 review M1).

import { appUpdateState } from './app-update-host';
import { store } from './store';
import { sdkAnswerAskUserQuestion, sdkLiveAnswerables, sdkSend } from './agent-sdk';
import { getMobileConversation, subscribeMobileFeed } from './acces-mobile-feed';
import { markWorkspaceSeen } from './mark-seen';
import { projectMobileWorkspaces, type MobileWorkspaceRow } from '../shared/acces-mobile';
import { MOBILE_SEND_MAX_CHARS, parseMobileAttachments, validWorkspaceId } from '../shared/acces-mobile-conversation';
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
          ...(update.kind === 'installed' ? { appUpdate: { version: update.version } } : {}),
        };
      }
      case '/mobile/conversation': {
        // One workspace's conversation, folded + projected for the phone (account-aware history).
        const ws = liveWorkspace(msg.id);
        return ws ? getMobileConversation(ws.id) : { ok: false, error: 'unknown workspace' };
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
