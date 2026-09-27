// Official SDK adapter. lux-ade framing is local to this bridge; Claude's protocol stays in the SDK.
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {planItem} from '../plan.mjs';
import {TaskPlans} from './tasks.mjs';
import {Subagents} from './subagents.mjs';
import {toolContent,toolOutput} from '../tool.mjs';
import {pathToFileURL} from 'node:url';
import {accessSync,constants} from 'node:fs';
import {resolve,join} from 'node:path';
function executable() {
  const requested=process.env.ADE_CLAUDE_BIN??'claude';
  const candidates=requested.includes('/')?[resolve(requested)]:(process.env.PATH??'').split(':').filter(Boolean).map(dir=>join(dir,requested));
  for(const candidate of candidates) {try {accessSync(candidate,constants.X_OK);return candidate;} catch {}}
  throw new Error('Claude Code executable is unavailable; install Claude Code or set ADE_CLAUDE_BIN');
}

export class Bridge {
  constructor(sdk, emit, cwd=process.cwd()) {
    this.sdk=sdk;this.emit=emit;this.cwd=cwd;this.session=null;this.query=null;this.active=null;
    this.inputs=[];this.wake=null;this.closed=false;this.permissions=new Map();this.partial=new Map();
    this.todoCalls=new Map();
    // Each query() reads its own input generator; a rewind starts a new generation.
    this.generation=0;
    this.taskPlans=new TaskPlans();
    this.subagents=new Subagents();
    this.toolCalls=new Map();this.toolBytes=0;
  }
  async *input(generation) {
    while(!this.closed&&this.generation===generation) {
      if(this.inputs.length) {yield this.inputs.shift();continue;}
      await new Promise(resolve=>{this.wake=resolve;});
    }
  }
  item(id,role,kind,text,turn,status='completed',client_id=null) {
    if(Buffer.byteLength(text)>(role==='user'?9:1)*1024*1024) throw new Error('Claude message exceeds the content limit');
    return {id,client_id,turn,role,kind,text,status};
  }
  content(message,turn,client=null) {
    // Child bodies belong to their own transcript, never the parent's plan,
    // tool registry or assistant response. Lifecycle summaries appear above it.
    if(message.parent_tool_use_id)return [];
    const role=message.type;const body=message.message??{};const content=body.content;
    if(typeof content==='string')return [this.item(message.uuid,role,'text',content,turn,'completed',client)];
    const items=[];
    if(role==='user') {
      const text=(content??[]).filter(b=>b.type==='text').map(b=>b.text??'').join('\n');
      if(text||(content??[]).some(b=>b.type==='image'||b.type==='document'))items.push(this.item(message.uuid,role,'text',text,turn,'completed',client));
    }
    for(const [index,block] of (content??[]).entries()) {
      const id=role==='user'&&block.type==='text'?message.uuid:`${body.id??message.uuid}:${index}`;
      if(block.type==='text'&&role!=='user')items.push(this.item(id,role,'text',block.text??'',turn,'completed',client));
      else if(block.type==='tool_use') {
        this.taskPlans.start(block,turn);
        const call={...this.item(block.id,'tool',block.name??'tool',JSON.stringify(block.input??{},null,2),turn,'streaming'),content:toolContent(block.id,block.name??'tool',{input:block.input??{}})};
        const bytes=Buffer.byteLength(JSON.stringify(call));
        const previous=this.toolCalls.get(block.id);
        this.toolBytes+=bytes-(previous?.bytes??0);
        if(this.toolCalls.size>=256&&!previous||this.toolBytes>12*1024*1024)throw new Error('Claude pending tools exceed admission limits');
        this.toolCalls.set(block.id,{item:call,bytes});items.push(call);
        if(block.name==='TodoWrite') {
          const plan=planItem(`${turn ?? message.uuid}:plan`,turn,block.input?.todos);
          if(this.todoCalls.size>=256)throw new Error('Too many pending Claude plan updates');
          this.todoCalls.set(block.id,plan);
        }
      }
      else if(block.type==='tool_result') {
        const call=this.toolCalls.get(block.tool_use_id);
        const status=block.is_error?'failed':'completed';
        if(call) {
          this.toolCalls.delete(block.tool_use_id);this.toolBytes-=call.bytes;
          items.push({...call.item,status,content:{...call.item.content,is_error:!!block.is_error}});
        }
        const output=toolOutput(block.content);
        items.push({...this.item(`${block.tool_use_id}:result`,'tool','toolResult',output,call?.item.turn??turn,status),content:toolContent(block.tool_use_id,call?.item.content.name??'tool',{output,is_error:!!block.is_error})});
        const plan=this.todoCalls.get(block.tool_use_id);
        this.todoCalls.delete(block.tool_use_id);
        if(plan&&!block.is_error)items.push(plan);
        const tasks=this.taskPlans.result(block,message.tool_use_result);
        if(tasks)items.push(tasks);
      }
      // Private thinking/signatures are deliberately not persisted as visible transcript text.
    }
    return items;
  }
  event(value) {this.emit({method:'event',params:value});}
  async open({resume,config={},mcp_servers}) {
    if(this.query)throw new Error('Claude session already opened');
    this.session=resume??randomUUID();
    this.taskPlans.open(this.session,process.env.ADE_DATA_DIR?join(process.env.ADE_DATA_DIR,'claude-task-results'):null);
    const history=[];
    if(resume) {
      const info=await this.sdk.getSessionInfo(resume,{dir:this.cwd});
      if(!info)throw new Error('Claude session is unavailable; original session ID retained');
      const messages=await this.sdk.getSessionMessages(resume,{dir:this.cwd,limit:2001});
      if(messages.length>2000)throw new Error('Claude resume exceeds 2,000 messages; use the CLI for this session');
      let turn=null;
      for(const message of messages) {
        if(message.parent_tool_use_id)continue;
        if(message.type==='user'&&(typeof message.message?.content==='string'||message.message?.content?.some(b=>['text','image','document'].includes(b.type))))turn=message.uuid;
        history.push(...this.content(message,turn));
      }
    }
    const options={cwd:this.cwd,systemPrompt:{type:'preset',preset:'claude_code'},
      settingSources:config.setting_sources??[],permissionMode:config.permission_mode??'default',
      includePartialMessages:true,canUseTool:(name,input,options)=>this.permission(name,input,options),
      onElicitation:async()=>({action:'decline'}),
      ...(config.model?{model:config.model}:{}),
      // The profile MCP catalog resolved by the daemon (F131); references stay ${VAR}.
      ...(mcp_servers&&typeof mcp_servers==='object'?{mcpServers:mcp_servers}:{}),
      ...(resume?{resume}:{sessionId:this.session}),
      pathToClaudeCodeExecutable:executable(),
    };
    // Cumulative usage in results belongs to this query() call; the daemon
    // differences it only between results of the same query.
    this.usageStream={query_id:randomUUID(),fresh:!resume,results:0};
    this.options=options;
    this.query=this.sdk.query({prompt:this.input(this.generation),options});
    this.watch(this.query);
    try { await this.query.initializationResult(); }
    catch(error) {
      // Initialization can reject while the SDK iterator is still alive. Do not
      // leave a failed connection able to admit prompts or retain a child process.
      this.close();
      throw error;
    }
    return {session:this.session,history:[...new Map(history.map(item=>[item.id,item])).values()]};
  }
  async consume(query) {
    for await(const message of query) {
      if(message.session_id&&message.session_id!==this.session)throw new Error('Claude returned a different session ID; refusing session replacement');
      if(message.type==='system'&&message.subtype==='init')continue;
      if(query!==this.query)break;
      // A truncating resume the CLI refused (resumeDropsTurn) reports a result with no turn.
      if(message.type==='result'&&!this.active&&[...(message.errors??[]),message.result??''].some(text=>String(text).startsWith('Resume rejected'))) {
        this.event({type:'error',error:'Claude refused the conversation rewind; the history was kept'});
        continue;
      }
      const active=this.active;
      if(message.type==='rate_limit_event') {
        this.event({type:'usage',session:this.session,turn:active?.turn??null,source:'rate_limit_event',report:message.rate_limit_info??null});
        continue;
      }
      const child=this.subagents.consume(message,active?.turn);
      if(child)this.event({type:'item',session:this.session,item:child});
      if(!active)continue;
      if(message.type==='stream_event'&&!message.parent_tool_use_id) {
        const event=message.event;
        if(event.type==='message_start')this.messageId=event.message.id;
        if(event.type==='content_block_start'&&event.content_block.type==='text') {
          const id=`${this.messageId}:${event.index}`;
          this.partial.set(event.index,{id,text:event.content_block.text??''});
          this.event({type:'item',session:this.session,item:this.item(id,'assistant','text',event.content_block.text??'',active.turn,'streaming')});
        }
        if(event.type==='content_block_delta'&&event.delta.type==='text_delta') {
          const part=this.partial.get(event.index);if(!part)throw new Error('Claude delta has no message start');
          part.text+=event.delta.text;
          if(Buffer.byteLength(part.text)>1024*1024)throw new Error('Claude message exceeds 1 MiB');
          this.event({type:'delta',session:this.session,turn:active.turn,id:part.id,role:'assistant',kind:'text',text:event.delta.text});
        }
      } else if(message.type==='assistant'||message.type==='user') {
        // Full content overwrites partial text using the same provider message ID.
        for(const item of this.content(message,active.turn,message.uuid===active.message_id?active.submission:null))this.event({type:'item',session:this.session,item});
      } else if(message.type==='result') {
        for(const request of [...this.permissions.values()])request.resolve({behavior:'deny',message:'Turn ended'});
        this.permissions.clear();this.partial.clear();
        this.active=null;
        // Figures as reported; the daemon marks what the SDK left out as unavailable.
        const stream=this.usageStream;
        this.event({type:'usage',session:this.session,turn:active.turn,source:'result',report:{usage:message.usage??null,modelUsage:message.modelUsage??null,total_cost_usd:message.total_cost_usd??null,is_error:!!message.is_error,query_id:stream.query_id,fresh:stream.fresh,result_index:stream.results++}});
        this.event({type:'finished',session:this.session,turn:active.turn,status:active.cancelled?'interrupted':message.is_error?'failed':'completed',error:message.is_error?(message.errors??[message.result??message.subtype]).join('\n'):null});
      }
    }
    if(!this.closed&&query===this.query)throw new Error('Claude SDK stream closed; resume before continuing');
  }
  async child_transcript({session,child,offset=0,cursor=null}) {
    if(cursor!==null)throw new Error('Claude child reader uses message offsets');
    if(this.closed||!this.query||session!==this.session)throw new Error('Claude parent session is not connected');
    if(typeof child!=='string'||!/^[a-zA-Z0-9_-]{1,256}$/.test(child)||!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new Error('Invalid child transcript selector');
    const known=await this.sdk.listSubagents(session,{dir:this.cwd});
    if(!known.includes(child))throw new Error('Child transcript is not available in this parent session');
    const messages=await this.sdk.getSubagentMessages(session,child,{dir:this.cwd,offset,limit:51});
    const items=[];
    let bytes=0;
    for(const message of messages.slice(0,50)) {
      const blocks=typeof message.message?.content==='string'?[{type:'text',text:message.message.content}]:(message.message?.content??[]);
      for(const [index,block] of blocks.entries()) {
        let text;
        if(block.type==='text')text=block.text;
        else if(block.type==='tool_use')text=`${block.name}\n${JSON.stringify(block.input??{},null,2)}`;
        else if(block.type==='tool_result')text=toolOutput(block.content);
        else if(block.type==='image'||block.type==='document')text=`[${block.type} attachment]`;
        else continue; // Thinking is private and never part of the reader.
        if(typeof text!=='string')throw new Error('Invalid Claude child transcript text');
        const item=this.item(`${message.uuid}:${index}`,message.type,block.type,text,null);
        bytes+=Buffer.byteLength(JSON.stringify(item));
        if(bytes>2*1024*1024||items.length>=1000)throw new Error('Child transcript page exceeds display limits');
        items.push(item);
      }
    }
    return {type:'child_transcript',child_id:child,items,next_offset:messages.length>50?offset+50:null};
  }
  send({session,submission,message_id,text,attachments=[]}) {
    if(this.closed||!this.query||session!==this.session)throw new Error('Claude session is not connected');
    if(this.active)throw new Error('Claude already has an active turn');
    if(typeof message_id!=='string')throw new Error('Missing durable provider message ID');
    const content=[{type:'text',text}];
    for(const item of attachments) {
      const a=item.attachment;
      if(a.media_type.startsWith('image/'))content.push({type:'image',source:{type:'base64',media_type:a.media_type,data:item.data}});
      else content.push({type:'text',text:`Attached file ${a.name}:\n${Buffer.from(item.data,'base64').toString('utf8')}`});
    }
    this.active={turn:message_id,submission,message_id,cancelled:false};
    this.event({type:'started',session,turn:message_id});
    // Echo durable user identity immediately; a subsequent SDK echo/history merges by UUID.
    this.event({type:'item',session,item:this.item(message_id,'user','text',text,message_id,'completed',submission)});
    this.inputs.push({type:'user',uuid:message_id,session_id:session,parent_tool_use_id:null,message:{role:'user',content:attachments.length?content:text}});
    this.wake?.();this.wake=null;
    return {turn:message_id};
  }
  permission(name,input,options) {
    if(!this.active)return Promise.resolve({behavior:'deny',message:'No active lux-ade turn'});
    if(options.signal?.aborted)return Promise.resolve({behavior:'deny',message:'Request was cancelled'});
    const id=options.requestId??randomUUID();const turn=this.active.turn;
    return new Promise(resolve=>{
      const done=value=>{if(!this.permissions.delete(id))return;options.signal?.removeEventListener('abort',abort);resolve(value);this.event({type:'resolved',id});};
      const abort=()=>done({behavior:'deny',message:'Request was cancelled'});
      this.permissions.set(id,{resolve:done,name,input,turn});
      options.signal?.addEventListener('abort',abort,{once:true});
      let params={tool:name,input,reason:options.decisionReason??null,command:input.command??null};
      const questions=name==='AskUserQuestion';
      if(questions)params.questions=(input.questions??[]).map((q,index)=>({...q,id:String(index)}));
      this.event({type:'request',session:this.session,turn,id,method:questions?'claude/questions':'claude/toolApproval',params,supported:true});
    });
  }
  answer({id,decision,answers,reason}) {
    const request=this.permissions.get(id);
    if(!request||this.active?.turn!==request.turn)throw new Error('Claude request is stale');
    if(decision==='decline')request.resolve({behavior:'deny',message:reason??'Declined by the user'});
    else if(request.name==='AskUserQuestion') {
      if(decision!=='answer')throw new Error('Answer the questions');
      const mapped={};for(const [index,q] of (request.input.questions??[]).entries()) {
        const answer=answers?.[String(index)];if(typeof answer!=='string'||!answer.trim())throw new Error(`Answer required for ${index}`);
        mapped[q.question]=answer;
      }
      request.resolve({behavior:'allow',updatedInput:{...request.input,answers:mapped}});
    } else {if(decision!=='accept')throw new Error('Choose accept or decline');request.resolve({behavior:'allow',updatedInput:request.input});}
    return {};
  }
  async cancel({session,turn}) {
    if(session!==this.session||this.active?.turn!==turn)throw new Error('Turn is no longer active');
    this.active.cancelled=true;
    const queued=this.inputs.findIndex(message=>message.uuid===turn);
    if(queued>=0) {
      this.inputs.splice(queued,1);this.active=null;
      this.event({type:'finished',session,turn,status:'interrupted',error:null});
      return {};
    }
    const receipt=await this.query.interrupt();
    // This SDK exposes interrupt receipts but no public per-UUID queue cancel.
    // Never leave an acknowledged Stop with queued work that can execute later.
    if(!receipt||receipt.still_queued?.length) {
      this.close();
      throw new Error('Claude could not confirm cancellation of queued work. Connection stopped; Resume to continue.');
    }
    return {};
  }
  watch(query) {
    this.loop=this.consume(query).catch(error=>{
      if(query!==this.query)return;
      if(!this.closed)this.event({type:'exited',error:error.message});this.close();
    });
  }
  // Agent SDK 0.3.281 resumeSessionAt: restart the query from the last chain
  // entry before the prompt that started `drop_from`, so that turn and every
  // later one leave the session. Dropping only the last turn also passes
  // resumeDropsTurn, which the CLI validates. Nothing runs while it restarts.
  async rewind({session,drop_from}) {
    if(this.closed||!this.query||session!==this.session)throw new Error('Claude session is not connected');
    if(this.active||this.inputs.length)throw new Error('A turn is running; stop it before rewinding the conversation');
    if(typeof drop_from!=='string'||!drop_from)throw new Error('Missing the prompt to rewind before');
    const prompt=m=>m.type==='user'&&(typeof m.message?.content==='string'||m.message?.content?.some(b=>['text','image','document'].includes(b.type)));
    const chain=(await this.sdk.getSessionMessages(session,{dir:this.cwd,limit:2001})).filter(m=>!m.parent_tool_use_id);
    const index=chain.findIndex(m=>m.uuid===drop_from);
    if(index<0||!prompt(chain[index]))throw new Error('Claude history has no such prompt; nothing was rewound');
    if(index===0)throw new Error('Claude cannot resume before its first message; nothing was rewound');
    const single=!chain.slice(index+1).some(prompt);
    const {sessionId,...kept}=this.options;
    const options={...kept,resume:session,resumeSessionAt:chain[index-1].uuid,...(single?{resumeDropsTurn:drop_from}:{})};
    const previous=this.query;
    this.generation++;this.wake?.();this.wake=null;
    this.query=this.sdk.query({prompt:this.input(this.generation),options});
    previous.close();
    this.options={...kept,resume:session};
    this.usageStream={query_id:randomUUID(),fresh:false,results:0};
    this.watch(this.query);
    await this.query.initializationResult();
    return {};
  }
  close() {this.closed=true;for(const request of [...this.permissions.values()])request.resolve({behavior:'deny',message:'lux-ade disconnected'});this.query?.close();this.wake?.();}
}

export function serve(sdk) {
  const emit=value=>{
    const line=JSON.stringify(value)+'\n';
    if(Buffer.byteLength(line)>16*1024*1024)throw new Error('Claude bridge frame exceeds 16 MiB');
    if(!process.stdout.write(line)&&process.stdout.writableLength>16*1024*1024)throw new Error('lux-ade is not consuming Claude output');
  };
  const bridge=new Bridge(sdk,emit);
  let buffered=0;
  const reader=createInterface({input:process.stdin,crlfDelay:Infinity});
  process.stdin.on('data',bytes=>{buffered+=bytes.length;if(buffered>16*1024*1024){bridge.close();process.exit(1);}});
  reader.on('line',line=>{
    buffered=0;
    let frame;try{frame=JSON.parse(line);}catch{bridge.close();process.exit(1);}
    Promise.resolve().then(()=>{
      if(!['open','send','cancel','answer','child_transcript','rewind'].includes(frame.method))throw new Error('Unknown lux-ade bridge method');
      return bridge[frame.method](frame.params??{});
    }).then(result=>emit({id:frame.id,result}),error=>emit({id:frame.id,error:{message:error.message}}));
  });
  reader.on('close',()=>{bridge.close();process.exit(0);});
  process.on('SIGTERM',()=>{bridge.close();process.exit(0);});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) serve(await import('@anthropic-ai/claude-agent-sdk'));
