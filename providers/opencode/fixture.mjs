import { createServer } from 'node:http'

const mode = process.env.ADE_TEST_MODE
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64')}`
let healthChecks = 0
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== auth) return response.writeHead(401).end()
  if (request.url === '/api/info' && mode === 'installed') return response.writeHead(404).end()
  if (request.url === '/api/info' && mode === 'unauthorized') return response.writeHead(401).end()
  if (request.url === '/api/info' || request.url === '/api/health') {
    if (mode === 'warming' && healthChecks++ < 2) return response.writeHead(503).end()
    response.setHeader('content-type', 'application/json')
    return response.end(
      JSON.stringify({
        version: mode === 'old' ? '1.9.0' : '2.0.3',
        pid: mode === 'foreign' ? process.pid + 1 : process.pid,
      }),
    )
  }
  if (request.url === '/api/fail') return response.writeHead(403).end('SECRET should not reach callers')
  if (request.url === '/api/redirect') return response.writeHead(302, { location: 'http://127.0.0.1:1/' }).end()
  if (request.url === '/api/slow') return
  if (request.url === '/api/large') return response.end('x'.repeat(16 * 1024 * 1024 + 1))
  if (request.url === '/api/empty') return response.writeHead(204).end()
  if (request.url === '/api/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (mode === 'large-event') return response.end(`data: ${'x'.repeat(16 * 1024 * 1024 + 1)}`)
    const event = Buffer.from(': heartbeat\r\n\r\ndata: {"type":"test",\r\ndata: "text":"🙂"}\r\n\r\n')
    const unicode = event.indexOf(Buffer.from('🙂'))
    response.write(event.subarray(0, unicode + 1))
    setTimeout(() => response.end(event.subarray(unicode + 1)), 10)
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  response.end(JSON.stringify({ method: request.method, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }))
})
server.listen(0, '127.0.0.1', () => {
  if (mode === 'timeout') return
  if (mode === 'external') return console.log(JSON.stringify({ url: 'http://example.com:80/' }))
  if (mode === 'garbage') return console.log('not v2')
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }))
})
process.stdin.resume()
process.stdin.on('end', () => {
  server.closeAllConnections()
  server.close()
})
