#!/usr/bin/env python3
"""Local M4 regression budgets, not portable product SLAs. Consumes a real run."""
import json,sys
from pathlib import Path
report=json.loads(Path(sys.argv[1]).read_text())
# GPUI on_next_frame runs on a later frame-loop iteration and is throttled in
# inactive windows. Keep it as a diagnostic, not a presentation-time assertion.
failures=[]
for case in report['results']:
 for phase in case['phases']:
  if phase['phase']!='agents_and_terminals':continue
  metrics=phase['client_cumulative'];label=f"{case['windows_and_agents']} workspaces"
  for key,limit in [('ui_timer_lateness_us',16667),('provider_to_ui_render_us',100000)]:
   actual=metrics.get(key,{}).get('p95');count=metrics.get(key,{}).get('count',0)
   if actual is None or count<20 or actual>limit:failures.append(f'{label}: {key} p95={actual}, count={count}, budget={limit}')
  if phase['control_rtt_ms']['p95']>20:failures.append(f'{label}: daemon control p95 exceeds20ms')
  if case['stream_integrity']!='exact match':failures.append(f'{label}: transcript mismatch')
# Reconnect memory gate for the repeated-reconnect workload. Budgets cover native
# decode buffers and compact wire copies per window, plus fixed allocator slack.
for case in report['results']:
 steady=next(p for p in case['phases'] if p['phase']=='agents_and_terminals')
 for phase in case['phases']:
  if phase['phase']!='reconnected_while_streaming':continue
  payload_mib=phase['client_cumulative'].get('snapshot_bytes',{}).get('max',0)/1024**2
  for group,fixed,copies in [('runtime',16,8),('client',32,12)]:
   if group not in steady['peak_rss_mib']:continue
   limit=steady['peak_rss_mib'][group]+fixed+case['windows_and_agents']*copies*payload_mib
   actual=phase['peak_rss_mib'][group]
   if actual>limit:failures.append(f"{case['windows_and_agents']} workspaces reconnect {group} RSS {actual:.1f}MiB exceeds {limit:.1f}MiB")
if failures:
 print('RUNTIME_REGRESSION_FAIL\n'+'\n'.join(failures));sys.exit(1)
print('RUNTIME_REGRESSION_PASS: steady-state UI timer p95 <=16.7ms; provider-to-render entry p95 <=100ms; control p95 <=20ms; exact transcript; repeated reconnect memory budget')
