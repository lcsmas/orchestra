// FI-2 (main/server seam, ledger #423): the live Bloc HTML switch. Read at the moment of the act — a session start, a phone route — never cached.

import { store } from './store.ts';
import { readBlocHtmlEnabled } from '../shared/bloc-html-setting.ts';

/** Persist the switch and answer what is now stored. Sessions started afterwards follow it; a running one keeps its CLI's frozen env. */
export async function setBlocHtmlEnabled(next: boolean): Promise<boolean> {
  await store.setBlocHtmlEnabled(next === true);
  return isBlocHtmlEnabled();
}

/** ON unless the human turned it off; a throwing read answers OFF. */
export function isBlocHtmlEnabled(): boolean {
  return readBlocHtmlEnabled(() => store.getBlocHtmlEnabled());
}
