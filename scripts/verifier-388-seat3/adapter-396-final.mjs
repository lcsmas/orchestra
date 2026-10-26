// Adapter: the #396 FINAL tip's REAL builder (src/shared/browser-popup-window.ts @316d1765, extracted verbatim with git show) behind Electron's SHIPPED openGuestWindow merge.
// Mirrors routePopup/createPopupWindow: override = { webPreferences } (what routePopup returns), createWindow(given) → buildChildWindowOptions(given, { parent, parentSize }).
import { buildChildWindowOptions } from '/var/tmp/orch-1000-b17728/d83d09da2fea/p396/src/shared/browser-popup-window.ts';
const SIZE = process.env.PROBE_PARENT === 'unknown' ? undefined : { width: 1500, height: 950 };
export default async function adapter({ features, shipped, parent }) {
  let built = null;
  shipped.runOpenGuestWindow({
    features,
    override: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } },
    createWindow: (given) => { built = buildChildWindowOptions(given, { parent, ...(SIZE ? { parentSize: SIZE } : {}) }); return {}; },
  });
  return built;
}
