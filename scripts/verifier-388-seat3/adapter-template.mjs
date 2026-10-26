// Adapter template for hostile-features-probe.mjs — point it at the #396 member's NEW child-window option builder.
//   cd <repo checkout with node_modules/electron> && node <seat3>/hostile-features-probe.mjs --adapter <this file, edited>
// Contract: default export async ({ features, shipped, parent }) => the FINAL options object the app would hand to `new BrowserWindow(...)`.
// Run Electron's REAL merge with `shipped.runOpenGuestWindow({ features, override, createWindow })`:
//   - override-style fix: `override` = whatever the app returns as `overrideBrowserWindowOptions` (keys it does not name still come from the page);
//   - createWindow-style fix (what OPS 9203 describes): the app's own factory receives Electron's `{ webContents, ...pageDerivedOptions }`; capture what
//     the FACTORY builds, not what it was handed.
// Example for a createWindow-style fix whose pure builder is `buildChildWindowOptions(given, { parent })` (adapt names/paths):
//   import { buildChildWindowOptions } from '<repo>/src/shared/browser-popup-window.ts';   // run node with --experimental-strip-types
//   export default async ({ features, shipped, parent }) => { let built = null;
//     shipped.runOpenGuestWindow({ features, override: null, createWindow: (given) => { built = buildChildWindowOptions(given, { parent }); return {}; } });
//     return built; };
export default async function adapter() {
  throw new Error('edit me: wire the member\'s option builder here (see the comments above)');
}
