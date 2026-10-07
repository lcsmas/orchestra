// The ownership labels the keeper's Docker relay stamps on every container it creates (#291, ADR 0004, ledger #295
// FI-1.1). The label on the container is the ONLY ownership truth — no bus table. #292 (Pause stops/restarts the
// attributed containers) and #293 (per-workspace container memory) list containers by exactly these keys.

/** The member's workspace id. */
export const DOCKER_LABEL_WS = 'orchestra.ws';
/** The member's own run id at create time. */
export const DOCKER_LABEL_RUN = 'orchestra.run';

/** The workspace id a container is attributed to: the `orchestra.ws` value when it is a non-empty string with NO surrounding whitespace (what the relay stamps is an exact id; a
 *  hand-padded value is not one — Pause matches the label by exact equality, so accounting must not call it ws-b's while Pause would not stop it for ws-b). null = not attributed. */
export function attributedWorkspaceId(labels: Record<string, string> | null | undefined): string | null {
  const v = labels?.[DOCKER_LABEL_WS];
  return typeof v === 'string' && v.length > 0 && v === v.trim() ? v : null;
}
