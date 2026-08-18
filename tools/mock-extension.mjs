#!/usr/bin/env node
/**
 * Mock extension client — M1/M2 command-channel verification (PHASE9 §11).
 *
 * Replicates the exact frame shapes of the real `WsClient` (src/sw/ws-client.ts):
 *   - connects with `binaryType = 'arraybuffer'`
 *   - sends binary frames via `send(new TextEncoder().encode(JSON.stringify(obj)))`
 *   - bridge→extension heartbeat is `{type:'Ok',payload:{data:{status:'ping'}}}` → ignored
 *   - extension→bridge application ping is `{type:'PING'}`; bridge answers `status:'pong'`
 *   - bridge→extension command is `{type:'Command',payload:{request_id,command,params}}`
 *   - extension→bridge reply is `{type:'COMMAND_RESULT',payload:{request_id,result}}`
 *
 * It spawns the real `agent-bridge --mcp` binary and drives ONE `tools/call`
 * through the full path: MCP stdio → `send_command` → WS Command frame → mock
 * reply → `CommandResult` → MCP stdio result. (The `initialize`/`ping`/`tools/list`
 * framing was already exercised by the earlier NDJSON smoke test.)
 *
 * Modes:
 *   roundtrip — reply to the Command, expect isError:false + echoed result
 *   timeout   — never reply, expect command_timeout (isError:true)
 *
 * Env:
 *   BRIDGE_BIN              path to the binary (default ../target/debug/agent-bridge)
 *   PORT_FILE               discovery port file (default /tmp/momo_mcp_port.txt)
 *   MOMO_COMMAND_TIMEOUT_MS passed through to the bridge (timeout test uses a short value)
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODE = process.argv[2] ?? 'roundtrip';
const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_BIN = process.env.BRIDGE_BIN ?? path.join(here, '..', 'target', 'debug', 'agent-bridge');
const PORT_FILE = process.env.PORT_FILE ?? '/tmp/momo_mcp_port.txt';

const dbg = (...a) => console.error('[mock]', ...a);

const binFrame = (obj) => new TextEncoder().encode(JSON.stringify(obj));
function decodeFrame(data) {
  if (typeof data === 'string') data = new TextEncoder().encode(data).buffer;
  return JSON.parse(new TextDecoder().decode(data));
}

rmSync(PORT_FILE, { force: true });
const child = spawn(BRIDGE_BIN, ['--mcp', '--port', PORT_FILE], { stdio: ['pipe', 'pipe', 'inherit'] });

const port = await waitForPort();
dbg('bridge listening on port', port);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.binaryType = 'arraybuffer';

let finished = false;

ws.onopen = () => {
  dbg('WS connected; sending application PING to confirm registration');
  ws.send(binFrame({ type: 'PING' }));
};

ws.onmessage = (event) => {
  const msg = decodeFrame(event.data);

  if (msg.type === 'Ok' && msg.payload?.data?.status === 'ping') return; // heartbeat
  if (msg.type === 'Ok' && msg.payload?.data?.status === 'pong') {
    dbg('PONG received — connection registered. Sending tools/call to stdin.');
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'read_page_content', arguments: { tab_id: 17 } },
      }) + '\n',
    );
    return;
  }
  if (msg.type === 'Command') {
    console.log('[WS  <- bridge  Command]      ' + JSON.stringify(msg));
    if (MODE === 'timeout') {
      dbg('Command received; deliberately NOT replying (timeout path).');
    } else {
      const reply = {
        type: 'COMMAND_RESULT',
        payload: {
          request_id: msg.payload.request_id,
          result: { title: 'Example', url: 'https://example.com', markdown_content: '# Heading\n\nBody' },
        },
      };
      ws.send(binFrame(reply));
      console.log('[WS  -> bridge  CommandResult] ' + JSON.stringify(reply));
    }
    return;
  }
  dbg('unhandled WS frame:', JSON.stringify(msg));
};

ws.onerror = (e) => dbg('WS error', e?.message ?? e);
ws.onclose = (e) => dbg('WS closed', e.code, e.reason);

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    console.log('[MCP <- bridge  stdout]       ' + line);
    const msg = JSON.parse(line);
    if (msg.result?.isError !== undefined || msg.error) finish();
  }
});

function finish() {
  if (finished) return;
  finished = true;
  setTimeout(() => {
    child.kill();
    process.exit(0);
  }, 50);
}

child.on('exit', (code) => {
  if (!finished) process.exit(code ?? 0);
});

function waitForPort(retries = 400) {
  return new Promise((resolve, reject) => {
    (function tick() {
      if (existsSync(PORT_FILE)) return resolve(readFileSync(PORT_FILE, 'utf8').trim());
      if (--retries <= 0) return reject(new Error('port file never appeared'));
      setTimeout(tick, 25);
    })();
  });
}
