#!/usr/bin/env node
// LotCAD 웹 MCP 브리지 (Node, 외부 패키지 없음) - tools/lotcad_mcp_web.py 와 같은 일을 하고, 사용자가 할 일을 줄인다:
//   · Claude Desktop 확장 (.mcpb) 으로 설치 - Claude Desktop 이 Node 를 갖고 있어 따로 깔 것이 없다.
//   · 앱이 안 붙어 있으면 도구는 open_lotcad 하나 - 부르면 브라우저로 LotCAD 웹을 ?link=포트 로 열고 붙을 때까지 기다린다
//     (명령행에 link on 을 칠 필요가 없다). 앱이 붙으면 notifications/tools/list_changed 로 CAD 도구를 다시 받게 한다.
//   · 다른 도구를 불렀는데 앱이 없어도 같은 식으로 열고 기다린다.
// 메시지는 네이티브 link 와 같다: {"type":"tools"} · {"type":"call","tool","args"} -> {"type":"result","content","isError"}.
// 환경 변수: LOTCAD_PORT (7701 - 네이티브 앱의 7700 과 다른 자리), LOTCAD_WEB_URL (홈페이지 웹 앱), LOTCAD_TIMEOUT (초, 60), LOTCAD_ORIGINS (쉼표),
//            LOTCAD_NO_OPEN=1 (브라우저를 열지 않는다 - 시험).
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const PORT = Number(process.env.LOTCAD_PORT || 7701);
const HOST = '127.0.0.1';
const TIMEOUT = Number(process.env.LOTCAD_TIMEOUT || 60) * 1000;
const WEB_URL = process.env.LOTCAD_WEB_URL || 'https://lotcad.github.io/web/WebGPUApp.html';
const ORIGINS = (process.env.LOTCAD_ORIGINS || 'https://lotcad.github.io').split(',').map(s => s.trim().toLowerCase().replace(/\/$/, '')).filter(Boolean);
const SERVER_INFO = { name: 'lotcad-web', version: '0.3.0' };
const INSTRUCTIONS = 'LotCAD is a CAD app running in the browser (Z up; units in get_scene). If only open_lotcad is listed, call it first - '
  + 'it opens LotCAD and connects. Start with get_scene. Build with ai_actions or run_command (AutoCAD-style command line: a command, '
  + 'then its values in following calls). Check results with capture_view (image) and get_object. Everything is undoable with run_command "undo".';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const log = (...a) => process.stderr.write('[lotcad-mcp] ' + a.join(' ') + '\n');

// ── 브라우저 쪽 (WebSocket 서버) ──
let conn = null;            // 붙은 앱 하나 (새로 붙으면 그것으로)
let nextId = 1;
const waiting = new Map();  // 요청 id -> resolve
const connectWaiters = [];

function originAllowed(origin) {
  if (!origin) return true;   // 브라우저가 아닌 시험 도구
  const o = origin.toLowerCase().replace(/\/$/, '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
  return ORIGINS.includes(o);
}

function sendFrame(sock, op, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  sock.write(Buffer.concat([head, payload]));
}

function onAppMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;   // 인사 · pong
  const r = waiting.get(msg.id);
  if (r) { waiting.delete(msg.id); r(msg); }
}

function attach(sock) {
  if (conn && conn !== sock) conn.destroy();
  conn = sock;
  log('LotCAD web connected');
  while (connectWaiters.length) connectWaiters.shift()();
  notify('notifications/tools/list_changed');   // 이제 CAD 도구가 있다
  let buf = Buffer.alloc(0);
  let parts = [];
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let n = buf[1] & 0x7f, pos = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); pos = 4; }
      else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); pos = 10; }
      const maskAt = pos;
      if (masked) pos += 4;
      if (buf.length < pos + n) return;
      let payload = buf.subarray(pos, pos + n);
      if (masked) { const m = buf.subarray(maskAt, maskAt + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i & 3])); }
      buf = buf.subarray(pos + n);
      if (op === 8) { sock.end(); return; }                 // close
      if (op === 9) { sendFrame(sock, 10, payload); continue; }   // ping -> pong
      if (op === 1 || op === 0) {
        parts.push(payload);
        if (fin) { onAppMessage(Buffer.concat(parts).toString('utf8')); parts = []; }
      }
    }
  });
  sock.on('close', () => {
    if (conn === sock) { conn = null; log('LotCAD web disconnected'); notify('notifications/tools/list_changed'); }
  });
  sock.on('error', () => {});
}

const server = http.createServer((req, res) => { res.writeHead(426); res.end('LotCAD MCP bridge: WebSocket only'); });
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  if (!originAllowed(req.headers.origin)) { log('refused a connection from', req.headers.origin); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  attach(sock);
});
// 포트를 못 열면 (다른 프로그램이 같은 포트를 열고 있을 때) 앱이 붙을 수 없다 - 기다리지 않고 그 까닭을 답한다
let listenError = '';
server.on('error', e => { listenError = e.code || e.message; log(`cannot listen on ${HOST}:${PORT}: ${e.message}`); });
server.listen(PORT, HOST, () => log(`waiting for LotCAD web on ws://${HOST}:${PORT}`));

function requestApp(msg, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!conn) { reject(new Error('not connected')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('no answer')); }, timeout);
    waiting.set(id, m => { clearTimeout(timer); resolve(m); });
    sendFrame(conn, 1, Buffer.from(JSON.stringify({ ...msg, id }), 'utf8'));
  });
}

// 앱 열기 - 기본 브라우저로 웹 앱을 ?link=포트 로 (앱이 스스로 붙는다)
let lastOpen = 0;
function openApp() {
  if (process.env.LOTCAD_NO_OPEN === '1' || Date.now() - lastOpen < 15000) return false;
  lastOpen = Date.now();
  const url = WEB_URL + (WEB_URL.includes('?') ? '&' : '?') + 'link=' + PORT;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch (e) { log('could not open the browser:', e.message); return false; }
  log('opened', url);
  return true;
}
function waitConnected(ms) {
  if (conn) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => { const i = connectWaiters.indexOf(done); if (i >= 0) connectWaiters.splice(i, 1); resolve(false); }, ms);
    connectWaiters.push(done);
  });
}
async function ensureApp() {
  if (conn) return true;
  if (listenError) return false;
  openApp();
  return waitConnected(45000);   // 첫 실행은 앱 내려받기 · 크롬의 로컬 네트워크 허락까지
}

const NOT_CONNECTED = `LotCAD did not connect. A browser tab with LotCAD should have opened (${WEB_URL}). If Chrome asks to allow access to `
  + `apps on this device (local network), allow it. Or type \`link\` in LotCAD's command line. Then try again.`;
const OPEN_TOOL = {
  name: 'open_lotcad',
  description: 'Open LotCAD (CAD app) in the browser and connect to it. Call this first when it is the only LotCAD tool; '
    + 'after it connects, the CAD tools (get_scene, ai_actions, run_command, capture_view ...) appear.',
  inputSchema: { type: 'object', properties: {} },
};
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
const PORT_BUSY = () => `LotCAD cannot connect: port ${PORT} on this computer is already used by another program (${listenError}). `
  + `The installed LotCAD desktop app uses the same port - if it is running, close it and restart Claude, then try again.`;
const notConnected = () => text(listenError ? PORT_BUSY() : NOT_CONNECTED, true);

async function listTools() {
  if (!conn) return [OPEN_TOOL];
  try { return (await requestApp({ type: 'tools' }, 10000)).tools || [OPEN_TOOL]; } catch { return [OPEN_TOOL]; }
}

async function callTool(name, args) {
  if (name === 'open_lotcad' || name === 'engine_status') {
    if (await ensureApp()) return text('LotCAD is connected. Call tools/list again (or just use get_scene, ai_actions, run_command, capture_view).');
    return notConnected();
  }
  if (!(await ensureApp())) return notConnected();
  try {
    const r = await requestApp({ type: 'call', tool: name, args: args || {} });
    return { content: r.content || [], isError: !!r.isError };
  } catch (e) {
    return e.message === 'no answer' ? text('LotCAD did not answer in time.', true) : notConnected();
  }
}

// ── MCP (stdio, 한 줄 = JSON-RPC 하나) ──
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function notify(method) { write({ jsonrpc: '2.0', method }); }

async function handle(msg) {
  const { method, id } = msg;
  const params = msg.params || {};
  if (id === undefined || id === null) return null;   // 알림
  let result;
  if (method === 'initialize') {
    result = { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } },
               serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
  } else if (method === 'ping') {
    result = {};
  } else if (method === 'tools/list') {
    result = { tools: await listTools() };
  } else if (method === 'tools/call') {
    result = await callTool(params.name || '', params.arguments || {});
  } else {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
  }
  return { jsonrpc: '2.0', id, result };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async raw => {
  raw = raw.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  try {
    const out = await handle(msg);
    if (out) write(out);
  } catch (e) {
    log('error:', e.message);
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
  }
});
rl.on('close', () => process.exit(0));
