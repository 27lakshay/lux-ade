#!/usr/bin/env python3
"""Read-only regression checks for the GUI-only Conversation contract."""
import argparse
from pathlib import Path
from runtime import rpc
p=argparse.ArgumentParser();p.add_argument('--socket',required=True);a=p.parse_args();endpoint=Path(a.socket)
catalog=rpc(endpoint,{'op':'catalog.get'})
assert 'shared_terminal' not in str(catalog.get('providers',[]))
for c in catalog['catalog']['conversations']:
    assert not c.get('view_terminal') and not c.get('terminal_owner'), 'Legacy attachment was not retired'
for op in ['agent.surface','agent.tui','agent.gui','agent.native_history']:
    try:rpc(endpoint,{'op':op,'conversation_id':'conversation_removed_feature'})
    except RuntimeError as e:assert 'Unknown session operation' in str(e),(op,str(e))
    else:raise AssertionError(f'{op} is still exposed')
print('PASS: GUI-only provider catalogue; no Conversation terminal owners; switching/handoff endpoints removed')
