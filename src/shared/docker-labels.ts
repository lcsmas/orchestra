// The ownership labels the keeper's Docker relay stamps on every container it creates (#291, ADR 0004, ledger #295
// FI-1.1). The label on the container is the ONLY ownership truth — no bus table. #292 (Pause stops/restarts the
// attributed containers) and #293 (per-workspace container memory) list containers by exactly these keys.

/** The member's workspace id. */
export const DOCKER_LABEL_WS = 'orchestra.ws';
/** The member's own run id at create time. */
export const DOCKER_LABEL_RUN = 'orchestra.run';
