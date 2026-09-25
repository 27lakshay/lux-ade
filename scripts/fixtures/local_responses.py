"""Deterministic loopback Responses endpoint for native CLI protocol tests."""
import json
from uuid import uuid4
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlsplit

ANSWER='lux-ade native loopback answer'

class Responses:
    def __init__(self):
        self.calls=[]
        self.pause_before_completion=None
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                size=int(self.headers.get('Content-Length','0'))
                if size>4*1024*1024:
                    self.send_error(413);return
                payload=json.loads(self.rfile.read(size))
                owner.calls.append((self.path,payload))
                route=urlsplit(self.path).path
                if route.endswith('/messages/count_tokens'):
                    body=json.dumps({'input_tokens':1}).encode()
                    self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
                if route.endswith('/messages'):
                    message={'id':'msg_native_claude_'+uuid4().hex,'type':'message','role':'assistant','model':payload.get('model','claude-sonnet-4-6'),'content':[{'type':'text','text':ANSWER}],
                             'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':1}}
                    if not payload.get('stream'):
                        body=json.dumps(message).encode();content_type='application/json'
                    else:
                        events=[
                            {'type':'message_start','message':{**message,'content':[],'stop_reason':None,'usage':{'input_tokens':1,'output_tokens':0}}},
                            {'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}},
                            {'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':ANSWER}},
                            {'type':'content_block_stop','index':0},
                            {'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':1}},
                            {'type':'message_stop'},
                        ]
                        body=''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode();content_type='text/event-stream'
                    self.send_response(200);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
                if not route.endswith('/responses'):
                    self.send_error(404);return
                part={'type':'output_text','text':ANSWER,'annotations':[]}
                item={'id':'msg_native_test_'+uuid4().hex,'type':'message','role':'assistant','status':'completed','content':[part]}
                response={'id':'resp_native_test_'+uuid4().hex,'object':'response','created_at':1,'status':'completed','model':'native-fixture','output':[item],
                          'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
                events=[
                    {'type':'response.created','response':{**response,'status':'in_progress','output':[]}},
                    {'type':'response.output_item.added','output_index':0,'item':{**item,'status':'in_progress','content':[]}},
                    {'type':'response.content_part.added','item_id':item['id'],'output_index':0,'content_index':0,'part':{**part,'text':''}},
                    {'type':'response.output_text.delta','item_id':item['id'],'output_index':0,'content_index':0,'delta':ANSWER},
                    {'type':'response.output_text.done','item_id':item['id'],'output_index':0,'content_index':0,'text':ANSWER},
                    {'type':'response.content_part.done','item_id':item['id'],'output_index':0,'content_index':0,'part':part},
                    {'type':'response.output_item.done','output_index':0,'item':item},
                    {'type':'response.completed','response':response},
                ]
                body=''.join('event: '+e['type']+'\ndata: '+json.dumps({**e,'sequence_number':i})+'\n\n' for i,e in enumerate(events)).encode()
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(body)));self.end_headers()
                if owner.pause_before_completion is not None:
                    split=body.index(b'event: response.output_text.done')
                    self.wfile.write(body[:split]);self.wfile.flush()
                    owner.pause_before_completion.wait(45)
                    self.wfile.write(body[split:])
                else:self.wfile.write(body)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
    @property
    def url(self):return f'http://127.0.0.1:{self.server.server_port}/v1'
    def close(self):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=5)
