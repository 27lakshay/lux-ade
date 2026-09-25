#!/usr/bin/env python3
"""Timed stdio provider for runtime benchmarks. Synthetic text, no model calls."""
import json, os, sys, threading, time, uuid
from pathlib import Path
root=Path(os.environ['ADE_MOCK_DIR']);root.mkdir(parents=True,exist_ok=True)
output=threading.Lock(); state=threading.RLock(); stop=threading.Event()
thread=None;active=None;worker=None

def send(v):
 with output: print(json.dumps(v,separators=(',',':')),flush=True)
def note(method,p):send({'method':method,'params':p})
def save():
 with state:
  target=root/(thread['id']+'.json');temporary=target.with_suffix('.next');temporary.write_text(json.dumps(thread));temporary.replace(target)
def stream_turn(params):
 global active
 text=params['input'][0]['text'];key=params['clientUserMessageId'];turn_id='turn-'+key
 user={'type':'userMessage','id':'user-'+key,'clientId':key,'content':[{'type':'text','text':text}]}
 active={'id':turn_id,'status':'inProgress','items':[user]};thread['turns'].append(active)
 base={'threadId':thread['id'],'turnId':turn_id}
 note('turn/started',{'threadId':thread['id'],'turn':active});note('item/completed',{**base,'item':user})
 if text.startswith('seed:'):
  for n in range(int(text.split(':')[1])):
   item={'id':f'{key}-{n}','type':'agentMessage','text':f'Previous message {n}\n'+('A measured historical response. '*30)}
   active['items'].append(item);note('item/completed',{**base,'item':item});time.sleep(.002)
 else:
  _,duration,rate,width=text.split(':');duration=float(duration);rate=float(rate);width=int(width)
  item={'id':'answer-'+key,'type':'agentMessage','text':''};active['items'].append(item);note('item/started',{**base,'item':item})
  start=time.monotonic();next_save=start+1
  for n in range(int(duration*rate)):
   if stop.wait(max(0,start+n/rate-time.monotonic())):break
   delta=f'Output {n:05d} '+('stream data '*(width//12))+f'ADE_AGENT:{time.time_ns()//1000};\n'
   item['text']+=delta;note('item/agentMessage/delta',{**base,'itemId':item['id'],'delta':delta})
   if time.monotonic()>next_save:save();next_save=time.monotonic()+1
  note('item/completed',{**base,'item':item})
 active['status']='interrupted' if stop.is_set() else 'completed';save();note('turn/completed',{'threadId':thread['id'],'turn':active})

for line in sys.stdin:
 m=json.loads(line);method=m.get('method');p=m.get('params',{});rid=m.get('id')
 if method=='initialize':send({'id':rid,'result':{'userAgent':'ade-runtime-fixture'}})
 elif method=='thread/start':
  thread={'id':'bench-'+str(uuid.uuid4()),'turns':[]};save();send({'id':rid,'result':{'thread':thread}})
 elif method=='thread/resume':
  thread=json.loads((root/(p['threadId']+'.json')).read_text());send({'id':rid,'result':{'thread':thread}})
 elif method=='turn/start':
  stop.clear();worker=threading.Thread(target=stream_turn,args=(p,),daemon=True);worker.start();send({'id':rid,'result':{'turn':{'id':'turn-'+p['clientUserMessageId'],'status':'inProgress'}}})
 elif method=='turn/interrupt':stop.set();send({'id':rid,'result':{}})
 elif method and method!='initialized':send({'id':rid,'error':{'code':-32601,'message':'Unsupported benchmark operation'}})
stop.set()
if worker:worker.join(2)
