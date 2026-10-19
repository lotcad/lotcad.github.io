#!/usr/bin/env node
// LotCAD 웹 MCP 브리지 (Node, 외부 패키지 없음) - tools/lotcad_mcp_web.py 와 같은 일을 하고, 사용자가 할 일을 줄인다:
//   · Claude Desktop 확장 (.mcpb) 으로 설치 - Claude Desktop 이 Node 를 갖고 있어 따로 깔 것이 없다.
//   · 도구 목록은 앱이 없어도 open_lotcad + CAD 도구 전부 (CAD_TOOLS 고정 사본 - 목록을 한 번만 읽는 클라이언트도 바로 쓴다).
//   · 아무 도구나 불렀는데 앱이 없으면 브라우저로 LotCAD 웹을 ?link=포트 로 열고 붙을 때까지 기다린다
//     (명령행에 link on 을 칠 필요가 없다). 앱이 붙으면 notifications/tools/list_changed 도 보낸다 (다시 읽는 클라이언트용).
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
const SERVER_INFO = { name: 'lotcad-web', version: '0.3.2' };
const INSTRUCTIONS = 'LotCAD is a CAD app running in the browser (Z up; units in get_scene). Any LotCAD tool opens LotCAD and connects '
  + 'by itself if it is not open yet (the first call can take a while). Start with get_scene. Build with ai_actions or run_command (AutoCAD-style command line: a command, '
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

// 자리 넘기기. Claude Desktop 은 확장을 두 벌 띄울 때가 있다 (같은 순간에 둘, 한쪽은 대화가 쓰고 다른 쪽은 놀고).
// 먼저 포트를 잡은 쪽에 웹이 붙고, 대화가 부르는 쪽은 포트가 없어 '다른 프로그램이 쓴다' 고만 답했다 (2026-10-19).
// 그래서 '쓰이는 쪽이 포트를 가진다': 포트가 없는 브리지가 도구 호출을 받으면 지금 주인에게 비켜 달라고 하고 (아래
// requestYield) 포트를 잡는다. 웹 앱은 2 초마다 다시 붙으므로 새 주인에게 곧 붙는다.
// 사용자 정의 헤더를 요구한다 - 웹 페이지는 CORS 사전 요청 없이는 이 헤더를 못 보내고, 여기는 그 요청에 답하지 않는다.
const YIELD_PATH = '/lotcad-yield';
const YIELD_HEADER = 'x-lotcad-yield';
let yielded = false;        // 남에게 넘겨줬다 - 스스로 다시 잡지 않는다 (쓰일 때만 되찾는다)

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === YIELD_PATH && req.headers[YIELD_HEADER] === '1' && !req.headers.origin) {
    log('another LotCAD bridge is being used - handing the port over');
    res.writeHead(200, { Connection: 'close' }); res.end('ok');
    yielded = true;
    listening = false;
    listenError = 'handed over';
    if (conn) { conn.destroy(); conn = null; notify('notifications/tools/list_changed'); }
    server.close();
    return;
  }
  res.writeHead(426); res.end('LotCAD MCP bridge: WebSocket only');
});
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
let listening = false;
function listen() {
  return new Promise(resolve => {
    const onError = e => {
      server.off('listening', onListening);
      listening = false; listenError = e.code || e.message;
      log(`cannot listen on ${HOST}:${PORT}: ${e.message}`);
      resolve(false);
    };
    const onListening = () => {
      server.off('error', onError);
      listening = true; listenError = ''; yielded = false;
      log(`waiting for LotCAD web on ws://${HOST}:${PORT}`);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });
}
listen();

// 포트가 없는데 도구가 불렸다 - 지금 주인(다른 LotCAD 브리지)에게 비켜 달라고 하고 포트를 잡는다.
// 주인이 LotCAD 브리지가 아니면 (네이티브 데스크톱 앱 등) 요청이 실패하고 그대로 '포트를 쓴다' 로 답한다.
function requestYield() {
  return new Promise(resolve => {
    const req = http.request({ host: HOST, port: PORT, path: YIELD_PATH, method: 'POST',
                               headers: { [YIELD_HEADER]: '1' }, timeout: 2000 },
      res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
async function claimPort() {
  if (listening) return true;
  if (!yielded && await listen()) return true;           // 그새 비었으면 그냥 잡는다
  if (!(await requestYield())) return false;
  for (let i = 0; i < 20; ++i) {                         // 상대가 닫을 때까지 잠깐
    await new Promise(r => setTimeout(r, 150));
    if (await listen()) { log('took the port over'); return true; }
  }
  return false;
}

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
  if (!listening) {
    if (!(await claimPort())) return false;
    // 넘겨받았으면 열려 있던 탭이 2 초 안에 다시 붙는다 - 새 탭을 열기 전에 먼저 기다린다
    if (await waitConnected(5000)) return true;
  }
  openApp();
  return waitConnected(45000);   // 첫 실행은 앱 내려받기 · 크롬의 로컬 네트워크 허락까지
}

const NOT_CONNECTED = `LotCAD did not connect. A browser tab with LotCAD should have opened (${WEB_URL}). If Chrome asks to allow access to `
  + `apps on this device (local network), allow it. Or type \`link\` in LotCAD's command line. Then try again.`;
const OPEN_TOOL = {
  name: 'open_lotcad',
  description: 'Open LotCAD (CAD app) in the browser and connect to it. Not needed before other tools - they open and connect '
    + 'by themselves; use it to bring LotCAD up or check the connection.',
  inputSchema: { type: 'object', properties: {} },
};
// CAD 도구 정의의 사본 (원본은 앱 src/app/lot_app_mcp_tools.cpp mcpToolList). 웹이 붙기 전에도 tools/list 에 늘 낸다 -
// Claude 데스크톱 Code 탭은 tools/list_changed 를 받아도 목록을 다시 읽지 않아, 처음 목록에 없으면 세션 내내 안 보인다 (2026-10-19).
// 앱의 정의를 바꾸면 여기도 (회귀 mcp-link-node 가 웹이 낸 목록과 같은지 본다).
const CAD_TOOLS = [
  {"name":"get_scene","description":"Summary of the whole document: object count, kinds, layers, bounds (Z up, units field mm or m) and the first objects (id, kind, layer, center, size, radius/length/text). Read this first.","inputSchema":{"type":"object","properties":{"max_objects":{"type":"integer","description":"objects listed (default 50)"}},"required":[]}},
  {"name":"get_object","description":"Full JSON of one object: kind, layer, transform, bounds and kind-specific geometry in world units (line start/end, circle center/radius, polyline points, dimension value, feature history ...).","inputSchema":{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}},
  {"name":"query_objects","description":"Find object ids with a filter: {\"kind\":\"circle\"|[..], \"layer\":name|id, \"selected\":true, \"visible\":true, \"within\":{\"min\":[x,y,z],\"max\":[..]}, \"intersects\":{..}, \"near\":{\"point\":[x,y,z],\"radius\":r}, \"pick\":\"largest\"|\"smallest\", \"limit\":N}.","inputSchema":{"type":"object","properties":{"filter":{"type":"object"}},"required":["filter"]}},
  {"name":"select","description":"Set the selection (most edit commands act on it). Empty ids clears it. additive=true adds to it.","inputSchema":{"type":"object","properties":{"ids":{"type":"array","items":{"type":"integer"}},"additive":{"type":"boolean"}},"required":["ids"]}},
  {"name":"set_property","description":"Set one property by the same keys get_object returns (color [r,g,b] 0..1, visible, layer, position, scale, radius, start/end, points, closed, text, height, precision ...). World units. One undo step.","inputSchema":{"type":"object","properties":{"id":{"type":"integer"},"key":{"type":"string"},"value":{}},"required":["id","key","value"]}},
  {"name":"run_command","description":"Type one line into the AutoCAD-style command line, exactly as a user would, then Enter. Commands that wait for values take them in the next calls, e.g. \"circle\" -> \"0,0\" -> \"20\"; while waiting, text is a value, not a new command, and an empty text finishes the tool. cancel=true presses ESC (cancel the waiting command / tool). Examples: line, rec, circle, move, extrude, fillet, dli, undo, redo, zoom. The reply has the prompt the command is waiting on.","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"cancel":{"type":"boolean","description":"press ESC instead of typing"}},"required":[]}},
  {"name":"ai_actions","description":"Run structured CAD actions (same contract as the in-app AI command line): create_primitive (world units, position = base centre, solid sits on it in +Z: cube size [x,y,z]; wedge size [x,y,z]; sphere/torus radius (+minor_radius); cylinder/cone radius+height; pyramid radius+height+sides; tube radius+inner_radius+height), draw_sketch (line/circle/arc/polyline/rectangle/polygon/leader), edit_selected (select/move/copy/rotate/scale/color/delete/set/fillet/chamfer/join/offset/mirror/trim/extend/hatch with ids or filter), view_control, command. One undo step for the whole list. Returns what each action did.","inputSchema":{"type":"object","properties":{"actions":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","enum":["create_primitive","draw_sketch","edit_selected","view_control","file","create_room","analyze","create_floorplan","command","create_wall_graph","explode"]},"op":{"type":"string","enum":["move","copy","rotate","scale","color","delete","select","deselect","select_all","clear_all","set","pushpull","fillet","chamfer","remove_feature","meshfix","meshsmooth","meshdecimate","meshstitch","thicken","remesh","array3d","stretch","lengthen","break","union","intersect","subtract","hatch","shell","join","offset","mirror","trim","extend","interference","meshcheck","zoom_extents","zoom_to_last","top","front","right","iso","plan","ortho","perspective","grid_on","grid_off","light_on","light_off","light_toggle","style_shaded","style_shaded_edge","style_wireframe","style_wireframe_edge","style_hidden_line","open","save","import","plot","status","solve","auto","clear","amount","play","back","part","spin","balloons","bom","manual"]}},"required":["type"]}}},"required":["actions"]}},
  {"name":"capture_view","description":"Screenshot of the current viewport as an image, so you can check the result visually. clean=true hides the grid. max_size = longest side in px (default 1280).","inputSchema":{"type":"object","properties":{"clean":{"type":"boolean"},"max_size":{"type":"integer"}},"required":[]}},
];
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
const PORT_BUSY = () => `LotCAD cannot connect: port ${PORT} on this computer is already used by another program (${listenError}). `
  + `The installed LotCAD desktop app uses the same port - if it is running, close it and restart Claude, then try again.`;
const notConnected = () => text(listenError ? PORT_BUSY() : NOT_CONNECTED, true);

// 앱이 없어도 open_lotcad + CAD 도구 전부. 붙어 있으면 앱의 목록이 먼저, 고정 목록에만 있는 것은 뒤에 (빠지지 않게).
async function listTools() {
  let web = [];
  if (conn) { try { web = (await requestApp({ type: 'tools' }, 10000)).tools || []; } catch { web = []; } }
  const names = new Set(web.map(t => t.name));
  return [OPEN_TOOL, ...web, ...CAD_TOOLS.filter(t => !names.has(t.name))];
}

async function callTool(name, args) {
  if (name === 'open_lotcad' || name === 'engine_status') {
    if (await ensureApp()) return text('LotCAD is connected. Use get_scene, ai_actions, run_command, capture_view.');
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
