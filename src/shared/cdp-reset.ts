/**
 * What an agent can leave on the shared panel tab through `orchestra browser` (`set viewport|device|media|offline|geo|headers`,
 * `network route`, `emulate…`) and the command that undoes each. Measured in Electron 33: detaching the debugger does NOT clear
 * an `Emulation.setDeviceMetricsOverride` (the page kept innerWidth 360 after `detach()`), so the host sends these explicitly
 * when the agent's last session has been gone for the grace period, then detaches. Best effort: each command is independent.
 */
export function resetCommands(normalUserAgent: string): Array<[method: string, params: Record<string, unknown>]> {
  return [
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Emulation.setEmulatedMedia', { media: '', features: [] }],
    // a user-agent override cannot be "cleared": set it back to the panel's own (already normalized) UA
    ['Emulation.setUserAgentOverride', { userAgent: normalUserAgent }],
    ['Emulation.clearGeolocationOverride', {}],
    ['Emulation.setTimezoneOverride', { timezoneId: '' }],
    ['Emulation.setLocaleOverride', {}],
    ['Emulation.setCPUThrottlingRate', { rate: 1 }],
    ['Emulation.setScriptExecutionDisabled', { value: false }],
    ['Emulation.setFocusEmulationEnabled', { enabled: false }],
    ['Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
    ['Network.setExtraHTTPHeaders', { headers: {} }],
    ['Network.setCacheDisabled', { cacheDisabled: false }],
    ['Network.setBypassServiceWorker', { bypass: false }],
    ['Fetch.disable', {}],
    ['Page.setBypassCSP', { enabled: false }],
  ];
}
