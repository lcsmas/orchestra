// Profils navigateur (#400, ADR 0010) — the SERVICE: create / rename / delete a profile, attach / detach one on a
// workspace. Electron-free (every effect is a dep), so browser-profiles.test.ts drives the real orchestration; the
// wiring to the store, the session partitions and the panel is browser-profiles-host.ts. HUMAN-FACING only: the IPC
// registrar (browser-profiles-ipc.ts) is its one caller, and it refuses anything but the app's own window.
import type {
  BrowserPanelState,
  BrowserProfile,
  BrowserProfileId,
  BrowserProfileRefusal,
  BrowserProfileResult,
} from '../shared/types';
import { checkProfileName, decideAttach, decideDelete } from '../shared/browser-profile.ts';

export interface BrowserProfilesDeps {
  getProfiles(): BrowserProfile[];
  setProfiles(next: BrowserProfile[]): Promise<void>;
  /** Every workspace on record (archived included) with the profile it records. */
  workspaces(): ReadonlyArray<{ id: string; browserProfileId?: BrowserProfileId }>;
  /** Record (or clear, with undefined) a workspace's profile and tell the renderer. */
  setWorkspaceProfile(wsId: string, profileId: BrowserProfileId | undefined): Promise<void>;
  /** Rebuild the workspace's open panel on that identity (a no-op for a panel that is not open). */
  reprofilePanel(wsId: string, profileId: BrowserProfileId | undefined): BrowserPanelState;
  /** Workspaces whose OPEN panel runs on that profile right now (what the views do, not what a record says). */
  openPanelsOn(profileId: BrowserProfileId): string[];
  /** `true` once the views closed so far are really gone (their unload handlers can still write the partition), `false` on a timeout. */
  settleViews(): Promise<boolean>;
  /** Stop promoting / flushing the profile's cookies: a late cookie event must not re-create one in a partition about to be wiped. */
  stopSignIns(profileId: BrowserProfileId): void;
  /** Wipe a profile partition's cookies and storage. */
  clearStorage(profileId: BrowserProfileId): Promise<void>;
  mintId(): BrowserProfileId;
  now(): number;
}

export interface BrowserProfilesService {
  list(): BrowserProfile[];
  create(name: unknown): Promise<BrowserProfileResult>;
  rename(id: unknown, name: unknown): Promise<BrowserProfileResult>;
  remove(id: unknown): Promise<BrowserProfileResult>;
  /** `profileId === null` detaches (navigation éphémère). */
  assign(wsId: unknown, profileId: unknown): Promise<BrowserProfileResult>;
}

export function createBrowserProfilesService(deps: BrowserProfilesDeps): BrowserProfilesService {
  // One operation at a time: two quick clicks (create + delete, switch + switch) must not interleave their
  // read-modify-writes of the profile list or leave a panel half-rebuilt.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const refuse = (reason: BrowserProfileRefusal, message: string): BrowserProfileResult => ({
    ok: false,
    reason,
    message,
    profiles: deps.getProfiles(),
  });

  return {
    list: () => deps.getProfiles(),

    create: (name) =>
      serial(async () => {
        const profiles = deps.getProfiles();
        const c = checkProfileName(name, profiles);
        if (!c.ok) return refuse(c.reason, c.message);
        let id = deps.mintId();
        while (profiles.some((p) => p.id === id)) id = deps.mintId();
        const profile: BrowserProfile = { id, name: c.name, createdAt: deps.now() };
        await deps.setProfiles([...profiles, profile]);
        return { ok: true, profiles: deps.getProfiles(), profile };
      }),

    rename: (id, name) =>
      serial(async () => {
        const profiles = deps.getProfiles();
        const cur = profiles.find((p) => p.id === id);
        if (!cur) return refuse('unknown-profile', 'That browser profile no longer exists.');
        const c = checkProfileName(name, profiles, cur.id);
        if (!c.ok) return refuse(c.reason, c.message);
        const profile = { ...cur, name: c.name };
        await deps.setProfiles(profiles.map((p) => (p.id === cur.id ? profile : p)));
        return { ok: true, profiles: deps.getProfiles(), profile };
      }),

    remove: (id) =>
      serial(async () => {
        const profiles = deps.getProfiles();
        const d = decideDelete({ profiles, workspaces: deps.workspaces(), profileId: id as BrowserProfileId });
        if (!d.ok) return refuse(d.reason, d.message);
        const profileId = id as BrowserProfileId;
        // 1. every workspace carrying it goes back to navigation éphémère and its open tabs reload there — the old
        //    views (the only writers into the partition) are destroyed before anything is wiped;
        for (const wsId of d.detach) {
          await deps.setWorkspaceProfile(wsId, undefined);
          deps.reprofilePanel(wsId, undefined);
        }
        //    …and so is any OPEN panel still running on it though its workspace record says otherwise (a half-failed earlier move);
        for (const wsId of deps.openPanelsOn(profileId)) deps.reprofilePanel(wsId, undefined);
        //    …then we wait for the closed views to be really gone (async unload) so none can write the partition back;
        if (!(await deps.settleViews())) {
          // a view is still closing and could write the partition after the wipe: keep the profile, say so, the delete can simply be retried
          return refuse('storage', 'Some of the profile’s tabs are still closing. Wait a moment and delete it again.');
        }
        deps.stopSignIns(profileId);
        // 2. the partition's cookies and storage are cleared;
        try {
          await deps.clearStorage(profileId);
        } catch (e) {
          // 3a. …and when that fails the profile STAYS on record, so the delete can simply be retried — a profile
          //     dropped from the list with its sign-ins still on disk would be unreachable and undeletable.
          return refuse('storage', `Could not clear this profile’s stored sign-ins (${e instanceof Error ? e.message : String(e)}). It was kept; try deleting it again.`);
        }
        // 3b. only then is the profile forgotten.
        await deps.setProfiles(profiles.filter((p) => p.id !== profileId));
        return { ok: true, profiles: deps.getProfiles() };
      }),

    assign: (wsId, profileId) =>
      serial(async () => {
        const ws = deps.workspaces().find((w) => w.id === wsId);
        if (!ws || typeof wsId !== 'string') return refuse('unknown-workspace', 'That workspace no longer exists.');
        const target = profileId === null || profileId === undefined ? null : (profileId as BrowserProfileId);
        const d = decideAttach({ profiles: deps.getProfiles(), current: ws.browserProfileId, target });
        if (!d.ok) return refuse(d.reason, d.message);
        const prev = ws.browserProfileId;
        if (prev !== d.profileId) await deps.setWorkspaceProfile(wsId, d.profileId);
        let state: BrowserPanelState;
        try {
          state = deps.reprofilePanel(wsId, d.profileId);
        } catch (e) {
          // the panel could not move: do not leave the record claiming an identity the tabs do not run on
          if (prev !== d.profileId) await deps.setWorkspaceProfile(wsId, prev).catch(() => {});
          throw e;
        }
        return { ok: true, profiles: deps.getProfiles(), state };
      }),
  };
}
