import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Bridge} from './bridge.mjs';
import {fakeSdk} from './fake-sdk.mjs';

// Only the fake SDK runs; this path passes the installed-executable check.
process.env.ADE_CLAUDE_BIN=process.execPath;
test('typed tool results keep call identity and failure without embedding image bytes',()=>{
  const bridge=new Bridge({},()=>{});
  const started=bridge.content({type:'assistant',uuid:'a',message:{content:[{type:'tool_use',id:'call',name:'Read',input:{file_path:'a.png'}}]}},'turn')[0];
  assert.equal(started.status,'streaming');assert.equal(started.content.call_id,'call');
  const items=bridge.content({type:'user',uuid:'r',message:{content:[{type:'tool_result',tool_use_id:'call',is_error:true,content:[{type:'text',text:'failed'},{type:'image',source:{data:'PRIVATE_BYTES'}}]}]}},'turn');
  assert.equal(items[0].id,started.id);assert.equal(items[0].status,'failed');
  assert.equal(items[1].content.call_id,started.content.call_id);
  assert.equal(items[1].content.name,'Read');assert.equal(items[1].content.is_error,true);
  assert.ok(!JSON.stringify(items).includes('PRIVATE_BYTES'));
});
test('TodoWrite changes the typed plan only after a successful result',()=>{
  const bridge=new Bridge({},()=>{});
  const call=(id,status)=>({type:'assistant',uuid:`message-${id}`,message:{content:[{type:'tool_use',id,name:'TodoWrite',input:{todos:[{content:'Inspect',status}]}}]}});
  const result=(id,is_error=false)=>({type:'user',uuid:`result-${id}`,message:{content:[{type:'tool_result',tool_use_id:id,content:'done',is_error}]}});
  assert.equal(bridge.content(call('first','in_progress'),'turn').filter(i=>i.kind==='plan').length,0);
  const first=bridge.content(result('first'),'turn').find(i=>i.kind==='plan');
  assert.deepEqual(first.content.steps,[{step:'Inspect',status:'inProgress'}]);
  bridge.content(call('failed','completed'),'turn');
  assert.equal(bridge.content(result('failed',true),'turn').filter(i=>i.kind==='plan').length,0);
  bridge.content(call('last','completed'),'turn');
  const last=bridge.content(result('last'),'turn').find(i=>i.kind==='plan');
  assert.equal(first.id,last.id);assert.equal(last.content.steps[0].status,'completed');
});
async function wait(fn) {
  for(let n=0;n<200;n++){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,5));}
  throw new Error('Timed out');
}
async function fixture(run) {
  const directory=mkdtempSync(join(tmpdir(),'ade-claude-unit-'));
  const sdk=fakeSdk(directory),events=[];
  const bridge=new Bridge(sdk,frame=>events.push(frame.params));
  try {await run({bridge,sdk,events,directory});} finally {bridge.close();rmSync(directory,{recursive:true,force:true});}
}
test('stable user UUID, authoritative full text, resume and opt-in settings',()=>fixture(async({bridge,sdk,events})=>{
  const {session}=await bridge.open({config:{model:'fixture-model',setting_sources:['project'],permission_mode:'plan'}});
  assert.deepEqual(sdk.last.options.settingSources,['project']);assert.equal(sdk.last.options.permissionMode,'plan');
  assert.equal(sdk.last.options.model,'fixture-model');assert.equal(sdk.last.options.allowDangerouslySkipPermissions,undefined);
  const uuid=randomUUID();bridge.send({session,submission:'ade-submission',message_id:uuid,text:'hello'});
  await wait(()=>events.some(e=>e.type==='finished'));
  const items=events.filter(e=>e.type==='item').map(e=>e.item);
  assert.equal(items.find(i=>i.id===uuid).client_id,'ade-submission');
  assert.equal(items.at(-1).text,'Hello Claude');assert.equal(items.at(-1).id,`assistant-${uuid}:0`);
  bridge.close();
  const resumed=new Bridge(sdk,()=>{});
  try {
    const result=await resumed.open({resume:session});
    assert.equal(result.session,session);assert.equal(result.history.length,2);assert.equal(result.history[0].id,uuid);
    assert.deepEqual(sdk.last.options.settingSources,[]);
  } finally {resumed.close();}
}));
test('missing session never creates a replacement',()=>fixture(async({bridge,sdk})=>{
  await assert.rejects(bridge.open({resume:randomUUID()}),/unavailable/);assert.equal(sdk.last,null);
}));
test('tool decisions and questions are scoped and cannot be reused',()=>fixture(async({bridge,events})=>{
  const {session}=await bridge.open({});
  for(const text of ['approval','questions']) {
    const uuid=randomUUID();bridge.send({session,submission:uuid,message_id:uuid,text});
    const request=await wait(()=>events.find(e=>e.type==='request'&&e.turn===uuid));
    if(text==='questions') {
      assert.throws(()=>bridge.answer({id:request.id,decision:'answer',answers:{'0':'one'}}),/required/);
      bridge.answer({id:request.id,decision:'answer',answers:{'0':'one','1':'two'}});
    } else bridge.answer({id:request.id,decision:'decline'});
    await wait(()=>events.some(e=>e.type==='finished'&&e.turn===uuid));
    assert.throws(()=>bridge.answer({id:request.id,decision:'accept'}),/stale/);
  }
}));
test('interrupt receipts stop active work; unconfirmed queued work closes the connection',()=>fixture(async({bridge,sdk,events})=>{
  const {session}=await bridge.open({});
  const uuid=randomUUID();bridge.send({session,submission:uuid,message_id:uuid,text:'hold'});
  await wait(()=>events.some(e=>e.type==='delta'));
  await bridge.cancel({session,turn:uuid});
  await wait(()=>events.some(e=>e.type==='finished'&&e.status==='interrupted'));
  const second=randomUUID();bridge.send({session,submission:second,message_id:second,text:'queued'});
  await wait(()=>events.some(e=>e.type==='delta'&&e.turn===second));
  await assert.rejects(bridge.cancel({session,turn:second}),/Connection stopped/);
  assert.equal(sdk.last.closed,true);assert.throws(()=>bridge.send({session,message_id:randomUUID(),text:'must not run'}),/not connected/);
}));
test('multi-block user history has one stable item and excludes private thinking',()=>fixture(async({bridge})=>{
  const items=bridge.content({type:'user',uuid:'user',message:{content:[{type:'text',text:'one'},{type:'text',text:'two'},{type:'thinking',thinking:'private'}]}},'turn');
  assert.equal(items.length,1);assert.equal(items[0].id,'user');assert.equal(items[0].text,'one\ntwo');
}));

test('failed SDK initialization closes its runtime and refuses later prompts',()=>fixture(async({bridge,sdk})=>{
  const query=sdk.query.bind(sdk);
  sdk.query=options=>{
    const runtime=query(options);
    runtime.initializationResult=async()=>{throw new Error('Authentication unavailable');};
    return runtime;
  };
  await assert.rejects(bridge.open({}),/Authentication unavailable/);
  assert.equal(sdk.last.closed,true,'A failed startup must close its SDK runtime');
  assert.throws(()=>bridge.send({session:bridge.session,submission:'never',message_id:randomUUID(),text:'Do not execute'}),/not connected/);
}));

test('image and text attachments reach the SDK and a follow-up retains session identity',()=>fixture(async({bridge,sdk,events})=>{
  const {session}=await bridge.open({});
  const first=randomUUID();
  const data=Buffer.from('image fixture bytes').toString('base64');
  bridge.send({session,submission:'attachments',message_id:first,text:'Inspect these',attachments:[
    {attachment:{name:'pixel.png',media_type:'image/png'},data},
    {attachment:{name:'notes.txt',media_type:'text/plain'},data:Buffer.from('notes content').toString('base64')},
  ]});
  await wait(()=>events.some(e=>e.type==='finished'&&e.turn===first));
  const history=await sdk.getSessionMessages(session);
  assert.deepEqual(history[0].message.content,[
    {type:'text',text:'Inspect these'},
    {type:'image',source:{type:'base64',media_type:'image/png',data}},
    {type:'text',text:'Attached file notes.txt:\nnotes content'},
  ]);
  assert.ok(!JSON.stringify(events).includes(data),'image bytes must not enter the display transcript');
  const second=randomUUID();
  bridge.send({session,submission:'follow-up',message_id:second,text:'Next task'});
  await wait(()=>events.some(e=>e.type==='finished'&&e.turn===second));
  assert.equal(events.filter(e=>e.type==='finished').length,2);
  assert.equal(bridge.session,session);
  assert.equal(sdk.last.closed,false);
}));
