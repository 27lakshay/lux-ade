import { createInterface } from 'node:readline';
import { RpcFrameEncoder } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame';

const encoder = new RpcFrameEncoder();
const send = (frame) => process.stdout.write(encoder.encode(frame));
send({ type: 'ready', supportedProtocolVersions: process.argv.includes('--v1') ? [1] : [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const response = { type: 'response', id: request.id, command: request.type, success: true };
  switch (request.type) {
    case 'negotiate_protocol':
      encoder.setProtocolVersion(2);
      send({ ...response, data: { protocolVersion: 2 } });
      break;
    case 'prompt':
      send(response);
      send({ ...response, success: false, error: 'Scheduling failed' });
      break;
    case 'large':
      send({ ...response, data: { text: '界'.repeat(500000) } });
      break;
    case 'mismatch': send({ ...response, command: 'wrong' }); break;
    case 'hang': break;
    default: send({ ...response, data: request.value });
  }
}
