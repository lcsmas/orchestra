| run | arm | driver says | rows (driver / bus at the end) | bus messages (kinds) | last app sample vs window end | app alive thru window | app liveness log | independent check |
|---|---|---|---|---|---|---|---|---|
| lv1-control_hung | hung | CLEAN | 1 / 1 | 2 (dispatch,escalation) | -2s | True | bus-liveness: escalated 7ebb8c00-0000-4000-8000-000000000011 → 7ebb8c0 | OK |
| lv2-control_silent_idle | silent-idle | CLEAN | 1 / 1 | 2 (dispatch,escalation) | +8s | True | bus-liveness: escalated 96093531-0000-4000-8000-000000000011 → 9609353 | OK |
| lv3-must_fail_hung_liveness_ | hung (liveness OFF) | DIRTY | 0 / 0 | 1 (dispatch) | -3s | True | bus-liveness: would have escalated d458cc30-0000-4000-8000-00000000001 | OK |
| lv4-must_fail_mutant_release | done-idle | DIRTY | 1 / 1 | 3 (dispatch,escalation,worker_done) | -18s | True | bus-liveness: escalated 93d6bf51-0000-4000-8000-000000000011 → 93d6bf5 | OK |
| lv1-done_idle_1 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv2-done_idle_2 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv3-done_idle_3 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv1-done_idle_4 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv2-done_idle_5 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv3-done_idle_6 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv4-done_idle_7 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv5-done_idle_8 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv6-done_idle_9 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |
| lv7-done_idle_10 | done-idle | CLEAN | 0 / 0 | 2 (dispatch,worker_done) | -18s | True | - | OK |

independent check OK = bus readable and holding the dispatch row the harness sent, bus escalation rows == the driver's rows, and the app's own 60-s sample series reaches the end of the window (app alive, sweeping).
