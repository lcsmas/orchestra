#!/usr/bin/env python3
"""#438-fu — independent END-OF-WINDOW re-check of saved liveness-soak runs (ledger #443, seat-1 item 1). For every run it reads, from the rig dir the run left behind and NOT through the driver's collector:
  · the rig's bus.sqlite (read-only): escalation rows, total messages, kinds present (dispatch / worker_done), newest row time;
  · the app's own clock: first orchestra.log line, the LAST resources.jsonl sample (one per 60 s while the app lives) — the app was alive through the window iff the last sample is >= the estimated window end - 60 s;
  · the app's own liveness log lines (`bus-liveness: escalated | would have escalated`).
usage: soak-recheck.py <rig base dir> <report dir>... > recheck.md"""
import sys, os, json, sqlite3, glob, datetime

def ts(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

base = sys.argv[1]
rows = []
for rep in sys.argv[2:]:
    for f in sorted(glob.glob(os.path.join(rep, 'lv*.log'))):
        res = None
        for l in open(f, errors='replace'):
            if l.startswith('LIVSOAK-RESULT '):
                res = json.loads(l[15:])
        if not res:
            continue
        d = os.path.join(base, 'h-' + res['label'])
        r = {'run': os.path.basename(f)[:-4], 'arm': res['arm'], 'switch': res['switch'], 'driver': res['verdict'], 'driver_rows': len(res.get('rows', [])), 'polls': res.get('polls')}
        try:
            db = sqlite3.connect('file:%s?mode=ro' % os.path.join(d, 'bus.sqlite'), uri=True)
            r['bus_escalations'] = db.execute("select count(*) from messages where kind='escalation'").fetchone()[0]
            r['bus_messages'] = db.execute('select count(*) from messages').fetchone()[0]
            r['bus_kinds'] = ','.join(k for (k,) in db.execute('select distinct kind from messages order by kind'))
        except Exception as e:
            r['bus_error'] = str(e)[:60]
        try:
            log = open(os.path.join(d, 'logs', 'orchestra.log'), errors='replace').read().split('\n')
            first = ts(log[0].split(' ')[0])
            samples = [json.loads(l)['at'] / 1000 for l in open(os.path.join(d, 'logs', 'resources.jsonl')) if l.strip()]
            end_est = first + (res.get('tActivityAfterStartS') or 0) + res['windowS']
            r['app_first_log'] = datetime.datetime.fromtimestamp(first, datetime.timezone.utc).strftime('%H:%M:%S')
            r['last_sample_vs_window_end_s'] = round(samples[-1] - end_est)
            r['app_alive_through_window'] = samples[-1] >= end_est - 60
            r['liveness_log'] = [l.split(' [INFO] ')[1][:70] for l in log if 'bus-liveness: escalated' in l or 'would have escalated' in l]
        except Exception as e:
            r['app_error'] = str(e)[:60]
        r['ok'] = (r.get('bus_error') is None and r.get('app_error') is None and r['bus_messages'] >= 1 and 'dispatch' in r['bus_kinds'] and r['bus_escalations'] == r['driver_rows'] and r['app_alive_through_window'])
        rows.append(r)
print('| run | arm | driver says | rows (driver / bus at the end) | bus messages (kinds) | last app sample vs window end | app alive thru window | app liveness log | independent check |')
print('|---|---|---|---|---|---|---|---|---|')
for r in rows:
    print('| %s | %s%s | %s | %s / %s | %s (%s) | %+ds | %s | %s | %s |' % (r['run'], r['arm'], ' (liveness OFF)' if r['switch'] == 'off' else '', r['driver'], r['driver_rows'], r.get('bus_escalations', r.get('bus_error')), r.get('bus_messages'), r.get('bus_kinds'), r.get('last_sample_vs_window_end_s', 0), r.get('app_alive_through_window'), '; '.join(r.get('liveness_log', [])) or '-', 'OK' if r['ok'] else 'NOT PROVEN'))
print()
print('independent check OK = bus readable and holding the dispatch row the harness sent, bus escalation rows == the driver\'s rows, and the app\'s own 60-s sample series reaches the end of the window (app alive, sweeping).')
sys.exit(0 if all(r['ok'] for r in rows) else 1)
