// Deterministic SDK interface fixture. Never imports Claude or calls a model.
import {mkdirSync,readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

export function fakeSdk(directory) {
  mkdirSync(directory,{recursive:true});
  const file=id=>join(directory,`${id}.json`);
  const record=value=>appendFileSync(join(directory,'calls.jsonl'),JSON.stringify({pid:process.pid,...value})+'\n');
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const sdk={last:null,
    getSessionInfo:async id=>existsSync(file(id))?{sessionId:id}:undefined,
    getSessionMessages:async id=>JSON.parse(readFileSync(file(id),'utf8')).map(({tool_use_result,...entry})=>entry),
    listSubagents:async id=>JSON.parse(readFileSync(file(id),'utf8')).some(m=>m.parent_tool_use_id==='fixture-spawn')?['fixture-child']:[],
    getSubagentMessages:async(id,child,{offset,limit})=>JSON.parse(readFileSync(file(id),'utf8')).filter(m=>child==='fixture-child'&&m.parent_tool_use_id==='fixture-spawn').slice(offset,offset+limit),
    query({prompt,options}) {
      const session=options.resume??options.sessionId;
      // Recorded only when the catalog passed servers, so other call logs are unchanged.
      let history=options.resume?JSON.parse(readFileSync(file(session),'utf8')):[];
      // resumeSessionAt truncates the chain after that entry at boot. With
      // resumeDropsTurn the discarded range must be exactly that one turn,
      // or the resume is refused and the history kept, as the CLI documents.
      let rejected=false;
      if(options.resumeSessionAt) {
        const at=history.findIndex(m=>m.uuid===options.resumeSessionAt);
        const dropped=history.slice(at+1);
        const prompt=m=>m.type==='user'&&typeof m.message?.content==='string';
        rejected=at<0||(!!options.resumeDropsTurn&&(dropped[0]?.uuid!==options.resumeDropsTurn||dropped.slice(1).some(prompt)));
        if(!rejected)history=history.slice(0,at+1);
      }
      // Recorded only for a catalog or rewind launch, so other call logs are unchanged.
      if(options.mcpServers||options.resumeSessionAt)record({method:'query',session,resume:options.resume??null,
        ...(options.mcpServers?{mcpServers:options.mcpServers}:{}),
        ...(options.resumeSessionAt?{resumeSessionAt:options.resumeSessionAt,resumeDropsTurn:options.resumeDropsTurn??null,rejected}:{})});
      const messages=[];let wake=null,closed=false,current=null;
      // Cumulative per query() call, as the SDK reports modelUsage and total_cost_usd.
      const usage={inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:0};
      const save=()=>writeFileSync(file(session),JSON.stringify(history));
      const emit=value=>{messages.push({...value,session_id:session});wake?.();wake=null;};
      const finish=failed=>{
        if(!current||closed)return;
        const item={type:'assistant',uuid:randomUUID(),message:{id:current.answer,content:[{type:'text',text:current.output??'Hello Claude'}]}};
        const text=current.text;
        history.push(item);save();emit(item);current=null;
        const result={type:'result',is_error:failed,errors:failed?['Interrupted']:[],subtype:failed?'error_during_execution':'success'};
        // 'usage' and 'usage-unpriced' report fixture figures; other prompts report none.
        if(['usage','usage-unpriced'].includes(text)) {
          for(const [key,add] of Object.entries({inputTokens:10,outputTokens:5,cacheReadInputTokens:100,cacheCreationInputTokens:20,costUSD:0.5}))usage[key]+=add;
          Object.assign(result,{usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:100,cache_creation_input_tokens:20},
            modelUsage:{'claude-fixture':{...usage,webSearchRequests:0,contextWindow:200000,maxOutputTokens:32000,
              ...(text==='usage-unpriced'?{costBasis:'unknown'}:{})}},total_cost_usd:usage.costUSD});
          emit({type:'rate_limit_event',rate_limit_info:{status:'allowed_warning',rateLimitType:'five_hour',utilization:0.25,resetsAt:4102444800}});
        }
        emit(result);
      };
      const query={options,closed:false,
        async initializationResult(){return {};},
        async interrupt(){
          if(current?.text==='queued')return {still_queued:[current.uuid]};
          if(current?.text==='old-cli')return undefined;
          current?.abort.abort();finish(true);return {still_queued:[]};
        },
        close(){closed=true;query.closed=true;current?.abort.abort();wake?.();},
        async *[Symbol.asyncIterator](){while(!closed){if(messages.length){yield messages.shift();continue;}await new Promise(resolve=>wake=resolve);}},
      };
      sdk.last=query;save();
      if(rejected)queueMicrotask(()=>emit({type:'result',is_error:true,subtype:'error_during_execution',errors:[`Resume rejected by --resume-drops-turn: entries after ${options.resumeSessionAt} are not all from ${options.resumeDropsTurn}`]}));
      queueMicrotask(async()=>{
        for await(const user of prompt) {
          if(closed)break;
          const text=user.message.content;
          record({method:'send',uuid:user.uuid,text});
          current={uuid:user.uuid,answer:`assistant-${user.uuid}`,text,abort:new AbortController()};
          history.push(user);save();emit(user);
          if(text==='typed-subagents') {
            emit({type:'system',subtype:'task_started',task_id:'fixture-child',task_type:'local_agent',tool_use_id:'fixture-spawn',subagent_type:'research',description:'Inspect'});
            const child={type:'assistant',uuid:randomUUID(),parent_tool_use_id:'fixture-spawn',message:{content:[{type:'text',text:'Private child transcript'}]}};
            history.push(child);save();emit(child);
            setTimeout(()=>emit({type:'system',subtype:'task_notification',task_id:'fixture-child',tool_use_id:'fixture-spawn',status:'completed',summary:'Inspection complete'}),50);
          }
          if(text==='typed-tasks') {
            const steps=[['TaskCreate',{subject:'Build'},{task:{id:'task-1',subject:'Build'}}],['TaskUpdate',{taskId:'task-1',status:'completed'},{success:true,taskId:'task-1',updatedFields:['status']}]];
            for(const [name,input,output] of steps) {
              const toolId=randomUUID();
              const tool={type:'assistant',uuid:randomUUID(),message:{content:[{type:'tool_use',id:toolId,name,input}]}};
              const result={type:'user',uuid:randomUUID(),tool_use_result:output,message:{content:[{type:'tool_result',tool_use_id:toolId,content:'task operation completed'}]}};
              history.push(tool,result);save();emit(tool);emit(result);
            }
          }
          if(text==='typed-plan') {
            for(const status of ['in_progress','completed']) {
              const toolId=randomUUID();
              const tool={type:'assistant',uuid:randomUUID(),message:{content:[{type:'tool_use',id:toolId,name:'TodoWrite',input:{todos:[{content:'Inspect',status}]}}]}};
              const result={type:'user',uuid:randomUUID(),message:{content:[{type:'tool_result',tool_use_id:toolId,content:'updated'}]}};
              history.push(tool,result);save();emit(tool);emit(result);
            }
          }
          emit({type:'stream_event',event:{type:'message_start',message:{id:current.answer}}});
          emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
          for(const text of ['Hello ','Claude'])emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
          if(text==='handoff-stream') {
            current.output='Hello Claude';
            for(let i=0;i<80;i++) {
              const chunk=` [${i}]`;current.output+=chunk;
              emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:chunk}}});
              await sleep(40);
            }
          }
          if(text==='handoff-tool') {
            const tool=spawn(process.execPath,['-e','setTimeout(()=>{},30000)']);
            record({method:'tool',tool_pid:tool.pid});
            while(!existsSync(join(directory,'release-tool')))await sleep(20);
            tool.kill();await new Promise(resolve=>tool.on('exit',resolve));
          }
          if(['hold','queued','old-cli'].includes(text))continue;
          if(['approval','questions'].includes(text)) {
            const name=text==='questions'?'AskUserQuestion':'Bash';
            const input=text==='questions'?{questions:[{question:'First?'},{question:'Second?'}]}:{command:'echo fixture'};
            const answer=await options.canUseTool(name,input,{requestId:`request-${user.uuid}`,toolUseID:`tool-${user.uuid}`,signal:current.abort.signal});
            record({method:"answer",answer});
          }
          if(!closed)finish(false);
        }
      });
      return query;
    },
  };
  return sdk;
}
