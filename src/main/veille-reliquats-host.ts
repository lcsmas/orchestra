// Production wiring of the Veille's Reliquat port (#326; the port itself: veille-reliquats-port.ts, verdict: veille-reliquats.ts). The app-side pieces it needs: the Pause's keeper/CLI identity,
// #331's browser census + pass (resource-monitor), and the member's INBOX for the notice (printed at its next SessionStart / UserPromptSubmit WITHOUT waking it — a bus row would wake it
// straight out of its Veille).

import { cliOfMember } from './pause-trap-host.ts';
import { countBrowserReliquatsOf, stopBrowserReliquatsOf } from './resource-monitor.ts';
import { appendInboxBlock } from './inbox-write.ts';
import { inboxFilePath } from './inbox-tray.ts';
import { INBOX_DELIMITER, sanitizeInboxBody } from '../shared/inbox-blocks.ts';
import { makeVeilleReliquatPort, type VeilleReliquatPortDeps } from './veille-reliquats-port.ts';
import type { VeilleReliquatPort } from './veille-reliquats.ts';

/** Queue `text` as one block of the member's inbox file; false = it could not be written. */
export async function queueInboxText(wsId: string, text: string, file: string = inboxFilePath(wsId)): Promise<boolean> {
  try {
    await appendInboxBlock(file, `\n${INBOX_DELIMITER}\n${sanitizeInboxBody(text)}\n${INBOX_DELIMITER}\n`);
    return true;
  } catch {
    return false;
  }
}

export function productionVeilleReliquatPort(over: Partial<VeilleReliquatPortDeps> = {}): VeilleReliquatPort {
  return makeVeilleReliquatPort({
    cliOf: cliOfMember,
    countBrowsers: (wsId) => countBrowserReliquatsOf(wsId),
    stopBrowsers: (wsId, ctx) => stopBrowserReliquatsOf(wsId, { ignoreWindow: true, ...(ctx?.stillWanted ? { stillWanted: ctx.stillWanted } : {}) }),
    tell: (wsId, text) => queueInboxText(wsId, text),
    ...over,
  });
}
