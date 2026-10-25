// #389 — what the SHIPPED selection code would decide on THIS host, read-only: the real probe (one `gdbus … Properties.Get Locked` on the
// real default collection) under three launch environments. appendSwitch / exportBusAddress are spies — nothing is applied, nothing is written.
// Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/keyring-host-probe.mjs
import { selectLinuxPasswordStore } from '../src/main/linux-keyring.ts';

const runtime = process.env.XDG_RUNTIME_DIR || '/run/user/1000';
const base = { XDG_RUNTIME_DIR: runtime, PATH: '/usr/bin:/bin', HOME: process.env.HOME };
const variants = {
  'launcher exported no address (Electron then reads "disabled:")': { ...base, DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
  'launcher exported the user bus': { ...base, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` },
  'sway session exporting XDG_CURRENT_DESKTOP=sway': { ...base, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, XDG_CURRENT_DESKTOP: 'sway' },
};
for (const [name, env] of Object.entries(variants)) {
  const applied = [];
  const d = selectLinuxPasswordStore({ platform: 'linux', env, argv: ['electron', '.'], hasSwitch: () => false, appendSwitch: (n, v) => applied.push(`--${n}=${v}`), exportBusAddress: (a) => applied.push(`export DBUS_SESSION_BUS_ADDRESS=${a}`) });
  console.log(`${name}\n  → store=${d.store ?? 'Chromium default'} reason=${d.reason} probe=${d.probeMs}ms facts=[${d.facts}] would apply: ${applied.join(' ; ') || 'nothing'}`);
}
