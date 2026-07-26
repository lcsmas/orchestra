import { isClaudeAuthUrl } from '../shared/accounts';
import { platform } from './platform';
import { store } from './store';
import { log } from './logger';

// Routing for browser-opens that originate inside an account login flow. Split
// out of login-browser.ts so the decision (Claude auth URL → the account's
// isolated per-account BrowserWindow; anything else → system browser) lives in
// Electron-free code that hooks-server.ts can reach, with the `isClaudeAuthUrl`
// gate staying backend-side as the single source of truth.

/** Route a browser-open coming out of an account login PTY (shim → socket) or
 *  the login modal's link handler. Claude/Anthropic OAuth pages get the
 *  account's isolated login surface; everything else opens in the system
 *  browser. */
export function dispatchLoginUrlRequest(req: { accountId: string; url: string }): {
  ok: boolean;
  error?: string;
  mode?: 'window' | 'external';
} {
  const { accountId, url } = req;
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'not a web url' };
  const account = store.accounts.find((a) => a.id === accountId);
  if (account && isClaudeAuthUrl(url)) {
    log.info(`login-browser: opening auth url for account ${accountId}`);
    platform.openAccountLoginUrl(accountId, url, account.label);
    return { ok: true, mode: 'window' };
  }
  void platform.openExternal(url);
  return { ok: true, mode: 'external' };
}
