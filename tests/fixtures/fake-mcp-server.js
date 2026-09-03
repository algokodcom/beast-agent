'use strict';

/* Fake stdio MCP server — initialize/tools/list/tools/call'a cevap verir.
   Testte node ile spawn edilir. */
const lines = [];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.1' } },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: 'echo', description: 'Metni aynen döner', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
          { name: 'add', description: 'Toplama', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const text = name === 'echo' ? `ECHO:${args.text}` : name === 'add' ? `SUM:${(args.a || 0) + (args.b || 0)}` : 'bilinmeyen';
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } });
    return;
  }
}

/* sahte serverın stderr'ine gürültü — client yok saymalı */
process.stderr.write('fake-server started\n');
