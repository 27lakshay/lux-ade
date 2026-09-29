#!/usr/bin/env python3
"""Codex and Claude daemon handoff with real CLIs and local HTTP fixtures only."""
import argparse
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from threading import Event
from paths import PROJECT_ROOT
import fixtures.local_responses as responses
import runtime
from live_profile import missing_prerequisites


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',action='store_true',help='Run isolated installed-CLI handoffs without hosted model calls')
    args=parser.parse_args()
    if not args.run:parser.error('Use --run for local installed-CLI fixtures')
    missing=missing_prerequisites(['codex','claude'],True)
    if missing:
        print(json.dumps({'status':'failed','failureCategory':'prerequisite-unavailable','missing':missing,'unexecutedProviders':['codex','claude'],'scope':'loopback-only','hostedAuthenticationTested':False}))
        raise SystemExit(1)
    root=PROJECT_ROOT
    saved_environment=dict(os.environ)
    saved_arguments=sys.argv[:]
    saved_answer=responses.ANSWER
    responses.ANSWER='ADE_HANDOFF_CODEX ADE_HANDOFF_CLAUDE'
    server=responses.Responses();gate=Event();server.pause_before_completion=gate
    original_rpc=runtime.rpc
    boots=[]
    release_after_status=False
    def observed_rpc(endpoint,value,timeout=5):
     nonlocal release_after_status
     if value.get('op')=='agent.send':gate.clear()
     result=original_rpc(endpoint,value,timeout)
     if value.get('op')=='hello':
      boot=result.get('boot_id')
      if boot and boot not in boots:
       if boots:release_after_status=True
       boots.append(boot)
     if value.get('op')=='runtime.status' and release_after_status:
      release_after_status=False;gate.set()
     return result
    runtime.rpc=observed_rpc
    try:
     with tempfile.TemporaryDirectory(prefix='ade-handoff-local-validation-',dir='/tmp') as directory:
      home=Path(directory);config=home/'codex';config.mkdir()
      (config/'config.toml').write_text(f'''model = "gpt-5.2"
    model_provider = "ade_loopback"
    cli_auth_credentials_store = "file"
    web_search = "disabled"
    [analytics]
    enabled = false
    [feedback]
    enabled = false
    [model_providers.ade_loopback]
    name = "ADE local fixture"
    base_url = "{server.url}"
    wire_api = "responses"
    env_key = "LOOPBACK_KEY"
    requires_openai_auth = false
    supports_websockets = false
    request_max_retries = 0
    stream_max_retries = 0
    ''')
      env={'PATH':os.environ['PATH'],'HOME':str(home),'CODEX_HOME':str(config),'LOOPBACK_KEY':'local-placeholder-only','CLAUDE_CONFIG_DIR':str(home/'claude'),'ANTHROPIC_BASE_URL':server.url.removesuffix('/v1'),'ANTHROPIC_API_KEY':'local-placeholder-only','ANTHROPIC_AUTH_TOKEN':'local-placeholder-only','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_AUTOUPDATER':'1','TERM':'dumb'}
      for name in ('ADE_CODEX_BIN','ADE_CLAUDE_BIN'):
       if name in saved_environment:env[name]=saved_environment[name]
      os.environ.clear();os.environ.update(env)
      sys.argv=['scripts/test_agent_handoff_live.py','--run']
      runpy.run_path(str(root/'scripts/test_agent_handoff_live.py'),run_name='__main__')
      calls=[route for route,_ in server.calls if route.split('?')[0].endswith(('/responses','/messages'))]
      assert len(boots)==3 and len(calls)==2,(boots,calls)
      print(json.dumps({'type':'native_handoff_loopback','scope':'loopback-only','hostedAuthenticationTested':False,'daemonBoots':len(boots),'localModelCalls':len(calls)}))
    finally:
     gate.set();server.close()
     runtime.rpc=original_rpc
     os.environ.clear();os.environ.update(saved_environment)
     sys.argv=saved_arguments
     responses.ANSWER=saved_answer


if __name__=='__main__':
    main()
