import { useEffect, useState } from 'react';
import { secretsNotice, type SecretsState } from '../../shared/secrets-state';

/** The secret-storage state (#389), loaded once per mount. `null` until it answers (and if the call
 *  fails): no notice is shown for a state we could not read. Reused by every Settings surface that
 *  stores a secret — Linear key, Comptes, and #400's profils navigateur. */
export function useSecretsState(): SecretsState | null {
  const [state, setState] = useState<SecretsState | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.orchestra
      .getSecretsState()
      .then((s) => !cancelled && setState(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/** "Secrets are stored unencrypted on this machine" — rendered ONLY when encryption is unavailable;
 *  nothing at all when it works. Pass `state` to share one `useSecretsState()` with the caller. */
export function SecretsNotice({ state }: { state?: SecretsState | null }) {
  const own = useSecretsState();
  const notice = secretsNotice(state === undefined ? own : state);
  if (!notice) return null;
  return (
    <div className="secrets-notice" role="status" data-secrets-notice={notice.kind}>
      <span className="secrets-notice-icon" aria-hidden="true">⚠</span>
      <span>{notice.text}</span>
    </div>
  );
}
