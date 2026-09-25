#!/usr/bin/env python3
"""Measure one existing process; RSS excludes helpers and GPU allocations."""
import argparse,json,subprocess,time
p=argparse.ArgumentParser();p.add_argument('--pid',type=int,required=True);p.add_argument('--seconds',type=float,default=10);p.add_argument('--max-cpu',type=float);a=p.parse_args()
def read():
 cpu,rss=subprocess.check_output(['ps','-p',str(a.pid),'-o','time=,rss='],text=True).split()
 parts=list(map(float,cpu.split(':')));total=0
 for part in parts: total=total*60+part
 return total,int(rss)
before,_=read();start=time.monotonic();time.sleep(a.seconds);after,rss=read();elapsed=time.monotonic()-start
result={'pid':a.pid,'elapsed_seconds':round(elapsed,2),'cpu_percent_one_core':round((after-before)/elapsed*100,2),'rss_mib':round(rss/1024,2),'scope':'one process; excludes helpers and GPU'}
print(json.dumps(result,indent=2))
if a.max_cpu is not None and result['cpu_percent_one_core']>a.max_cpu: raise SystemExit(1)
