#!/usr/bin/env node
/**
 * Mock extension client — M1/M2 command-channel verification (PHASE9 §11).
 *
 * Replicates the exact frame shapes of the real `WsClient` (src/sw/ws-client.ts):
 *   - connects with `binaryType = 'arraybuffer'`
 *   - sends binary frames via `send(new TextEncoder().encode(JSON.stringify(obj)))`
 *   - extension→bridge first frame is `{type:'AUTH',payload:{token}}`; bridge answers
 *     `{type:'Ok',payload:{data:{status:'auth_ok'}}}` or an `Error` with request_id:'auth'
 *     (the mock sends MOMO_AUTH_TOKEN (fallback: ~/.momo/auth_token); the spawned bridge
 *     is deliberately stripped of MOMO_AUTH_TOKEN so it always expects the token from
 *     ~/.momo/auth_token — this lets tests simulate a wrong token)
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
 *   roundtrip   — tools/call read_page_content, reply with a canned Markdown result
 *   interactive — tools/call get_interactive_elements, reply with an elements array
 *                 (role/label/state/bounds) to prove the bridge round-trips it
 *   timeout     — never reply, expect command_timeout (isError:true)
 *   stale       — tools/call execute_action, reply with error:"stale_reference"
 *                 to prove the bridge maps it to isError:true (M4)
 *
 * Env:
 *   BRIDGE_BIN              path to the binary (default ../target/debug/agent-bridge)
 *   PORT_FILE               discovery port file (default /tmp/momo_mcp_port.txt)
 *   MOMO_COMMAND_TIMEOUT_MS passed through to the bridge (timeout test uses a short value)
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const MODE = process.argv[2] ?? 'roundtrip';
const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_BIN = process.env.BRIDGE_BIN ?? path.join(here, '..', 'target', 'debug', 'agent-bridge');
const PORT_FILE = process.env.PORT_FILE ?? '/tmp/momo_mcp_port.txt';

const dbg = (...a) => console.error('[mock]', ...a);

const TOKEN = process.env.MOMO_AUTH_TOKEN ?? (() => {
  try {
    return readFileSync(path.join(homedir(), '.momo', 'auth_token'), 'utf8').trim();
  } catch {
    return null;
  }
})();
if (!TOKEN) {
  dbg('No auth token found (set MOMO_AUTH_TOKEN or create ~/.momo/auth_token)');
  process.exit(2);
}

const binFrame = (obj) => new TextEncoder().encode(JSON.stringify(obj));
function decodeFrame(data) {
  if (typeof data === 'string') data = new TextEncoder().encode(data).buffer;
  return JSON.parse(new TextDecoder().decode(data));
}

rmSync(PORT_FILE, { force: true });
const childEnv = { ...process.env };
delete childEnv.MOMO_AUTH_TOKEN;
const child = spawn(BRIDGE_BIN, ['--mcp', '--port', PORT_FILE], { stdio: ['pipe', 'pipe', 'inherit'], env: childEnv });

const port = await waitForPort();
dbg('bridge listening on port', port);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.binaryType = 'arraybuffer';

let finished = false;

const watchdog = setTimeout(() => {
  if (!finished) {
    dbg('watchdog: no completion within 60s');
    child.kill();
    process.exit(1);
  }
}, 60_000);
watchdog.unref?.();

ws.onopen = () => {
  dbg('WS connected; sending AUTH frame');
  ws.send(binFrame({ type: 'AUTH', payload: { token: TOKEN } }));
};

ws.onmessage = (event) => {
  const msg = decodeFrame(event.data);

  if (msg.type === 'Ok' && msg.payload?.data?.status === 'auth_ok') {
    dbg('authenticated');
    ws.send(binFrame({ type: 'PING' }));
    return;
  }
  if (msg.type === 'Error' && msg.payload?.request_id === 'auth') {
    dbg('AUTH FAILED:', msg.payload.message);
    process.exit(1);
  }
  if (msg.type === 'Ok' && msg.payload?.data?.status === 'ping') return; // heartbeat
  if (msg.type === 'Ok' && msg.payload?.data?.status === 'pong') {
    dbg('PONG received — connection registered. Sending tools/call to stdin.');
    const tool =
      MODE === 'interactive' ? 'get_interactive_elements'
      : MODE === 'stale' ? 'execute_action'
      : 'read_page_content';
    const args = MODE === 'stale' ? { action: 'click', ref: 'el_45' } : { tab_id: 17 };
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }) + '\n',
    );
    return;
  }
  if (msg.type === 'Command') {
    console.log('[WS  <- bridge  Command]      ' + JSON.stringify(msg));
    if (MODE === 'timeout') {
      dbg('Command received; deliberately NOT replying (timeout path).');
    } else {
      const command = msg.payload.command;
      let result;
      if (command === 'get_interactive_elements') {
        result = {
          command,
          status: 'ok',
          success: true,
          url: 'https://example.com/page',
          page_revision: 3,
          elements: [
            {
              ref: 'el_1',
              role: 'button',
              label: 'Save',
              state: [],
              tag: 'button',
              bounds: { x: 10, y: 20, width: 100, height: 50, top: 20, right: 110, bottom: 70, left: 10 },
            },
            {
              ref: 'el_2',
              role: 'textbox',
              label: 'Search',
              state: ['focused'],
              tag: 'input',
              bounds: { x: 10, y: 90, width: 200, height: 40, top: 90, right: 210, bottom: 130, left: 10 },
            },
          ],
        };
      } else if (command === 'execute_action') {
        // Simulate the extension's ToolResult when strict ref resolution fails
        // (M4): error:"stale_reference" must map to isError:true on the bridge.
        result = {
          success: false,
          error: 'stale_reference',
          data: { error: 'stale_reference', ref: 'el_45', hint: 're-fetch get_interactive_elements' },
          summary: 'execute_action click: stale reference el_45',
          navigationOccurred: false,
        };
      } else {
        result = {
          command,
          status: 'ok',
          success: true,
          title: 'Example',
          url: 'https://example.com',
          markdown_content: '# Heading\n\nBody',
          ref_id_map: {},
          page_revision: 2,
        };
      }
      const reply = {
        type: 'COMMAND_RESULT',
        payload: { request_id: msg.payload.request_id, result },
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
