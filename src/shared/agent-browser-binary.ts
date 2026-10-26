/**
 * Which pinned `agent-browser` release asset runs on a platform (#395, ADR 0009), and the
 * resolution order of the binary on disk. Pins live in `scripts/agent-browser-pins.json`
 * (version + SHA-256 per asset); `scripts/agent-browser-fetch.cjs` downloads and verifies them.
 */
/** The pinned release; `agent-browser-binary.test.ts` asserts it equals `scripts/agent-browser-pins.json`. */
export const AGENT_BROWSER_VERSION = '0.39.2';

export interface AgentBrowserPins {
  version: string;
  repo: string;
  assets: Record<string, { name: string; sha256: string }>;
}

/** `<platform>-<arch>` key into the pins, or null for a platform we do not pin. */
export function assetKey(platform: string, arch: string): string | null {
  const a = arch === 'x64' || arch === 'arm64' ? arch : null;
  if (!a) return null;
  return platform === 'linux' ? `linux-${a}` : null;
}

export function assetFor(pins: AgentBrowserPins, platform: string, arch: string): { key: string; name: string; sha256: string } | null {
  const key = assetKey(platform, arch);
  const asset = key ? pins.assets[key] : undefined;
  return key && asset ? { key, ...asset } : null;
}

/** Where the bundled binary may live, in order: explicit override (rigs/dev) → packaged resources → the build dir. */
export function binaryCandidates(opts: { override?: string; resourcesPath?: string; appPath?: string }): string[] {
  const out: string[] = [];
  if (opts.override) out.push(opts.override);
  if (opts.resourcesPath) out.push(`${opts.resourcesPath}/agent-browser/agent-browser`);
  if (opts.appPath) out.push(`${opts.appPath}/build/agent-browser/agent-browser`);
  return out;
}
