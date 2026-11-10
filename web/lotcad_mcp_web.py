#!/usr/bin/env python3
"""LotCAD 웹 MCP 브리지 — MCP 클라이언트(Claude Desktop · Claude Code 등)와 브라우저에서 도는 LotCAD 웹 앱을 잇는다.

네이티브 tools/lotcad_mcp.py 와 같은 일을 하되, 브라우저는 접속을 받을 수 없으므로 방향이 반대다:
브리지가 127.0.0.1:7701 (네이티브 앱의 7700 과 다른 자리) 에서 WebSocket 을 열고, 웹 앱이 명령행 `link on` 으로 거기에 붙는다.
메시지는 네이티브 link 와 같다 — {"type":"tools","id":n} -> {"type":"tools","id":n,"tools":[…]},
{"type":"call","tool":…,"args":{…},"id":n} -> {"type":"result","id":n,"content":[…],"isError":bool}.
도구 정의는 앱 한 곳(src/app/lot_app_mcp_tools.cpp)에 있고 여기는 전달한다 - 앱이 붙기 전 tools/list 용 사본만 CAD_TOOLS 에.

쓰는 법
  1) MCP 클라이언트에 등록한다.
       Claude Code:     claude mcp add lotcad -- python3 /절대/경로/lotcad_mcp_web.py
       Claude Desktop:  claude_desktop_config.json 에
                        {"mcpServers": {"lotcad": {"command": "python3", "args": ["/절대/경로/lotcad_mcp_web.py"]}}}
  2) 브라우저에서 LotCAD 웹을 열고 명령행에 `link on` (브리지가 아직 없으면 앱이 몇 초마다 다시 붙는다).
  3) "머그컵 만들어 줘" — 모델이 get_scene · ai_actions · run_command · capture_view 로 만들고 화면을 확인한다.

자세 중계 (--relay [포트], 또는 LOTCAD_RELAY=포트): 그 TCP 포트 (기본 7700 - 네이티브 앱 자리) 에서 줄 단위 JSON 을 받아
  {"type":"pose"|"eye"|"ping"} 만 앱으로 넘긴다. 네이티브 tools/tag_tracker.py · 로봇 스크립트가 네이티브 앱 대신 웹 앱을 움직인다:
       python3 tools/lotcad_mcp_web.py --relay          (터미널에서 - MCP 클라이언트 없이 중계만, stdin 을 읽지 않는다)
       python3 ../3dEngine/tools/tag_tracker.py --map tag_map.json --port 7700
  브라우저 안에서 바로 추적하려면 앱의 명령 tag (카메라 창) - 이 중계가 필요 없다.

환경 변수: LOTCAD_PORT (기본 7701), LOTCAD_TIMEOUT (초, 기본 60), LOTCAD_RELAY (자세 중계 포트, 기본 끔),
           LOTCAD_ORIGINS (접속을 받을 페이지 출처, 쉼표로. 기본: localhost · 127.0.0.1 · https://lotcad.github.io).
외부 패키지 없음(파이썬 3.8+ 표준 라이브러리만). 로그는 stderr 로(stdout 은 MCP 메시지 전용).
"""
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading

PORT = int(os.environ.get("LOTCAD_PORT", "7701"))
RELAY = int(os.environ.get("LOTCAD_RELAY", "0"))
RELAY_TYPES = ("pose", "eye", "ping")   # 중계로는 이것만 - MCP 도구 (tools · call) 는 MCP 쪽으로만
HOST = "127.0.0.1"
TIMEOUT = float(os.environ.get("LOTCAD_TIMEOUT", "60"))
ORIGINS = [o.strip() for o in os.environ.get("LOTCAD_ORIGINS", "https://lotcad.github.io").split(",") if o.strip()]
SERVER_INFO = {"name": "lotcad-web", "version": "0.3.3"}
INSTRUCTIONS = (
    "LotCAD is a CAD engine running in a browser (Z up; units are the document's, see get_scene units). Start with "
    "get_scene. Build with ai_actions or run_command (AutoCAD-style command line: a command, then its values in following "
    "calls). Check results with capture_view (image) and get_object. Everything is undoable with run_command \"undo\"."
)
NOT_CONNECTED = (
    "LotCAD web is not connected to this bridge (ws://{host}:{port}). Open LotCAD in the browser and type `link` in its "
    "command line (`link port N` if LOTCAD_PORT is not 7701)."
)
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def log(*args):
    print("[lotcad-mcp-web]", *args, file=sys.stderr, flush=True)


def origin_allowed(origin):
    """다른 웹사이트가 앱인 척 붙지 못하게 — 로컬 페이지와 정한 출처만."""
    if not origin:
        return True   # 브라우저가 아닌 시험 도구
    o = origin.lower().rstrip("/")
    for local in ("http://localhost", "http://127.0.0.1", "https://localhost", "https://127.0.0.1"):
        if o == local or o.startswith(local + ":"):
            return True
    return o in [x.lower().rstrip("/") for x in ORIGINS]


class Browser:
    """웹 앱의 WebSocket 접속 하나 (새로 붙으면 그것으로 바꾼다). 요청마다 id 를 붙이고 같은 id 의 답을 기다린다."""

    def __init__(self):
        self.lock = threading.Condition()
        self.conn = None
        self.replies = {}
        self.next_id = 1
        self.send_lock = threading.Lock()
        self.listen_error = ""

    # ── WebSocket 서버 ──
    def serve(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind((HOST, PORT))
        except OSError as e:
            log(f"cannot listen on {HOST}:{PORT}: {e}")
            self.listen_error = str(e)   # 앱이 붙을 수 없다 - 도구 답에 까닭을 (네이티브 LotCAD 가 같은 포트일 때 등)
            return
        srv.listen(4)
        log(f"waiting for LotCAD web on ws://{HOST}:{PORT} (type `link on` in the app)")
        while True:
            c, _ = srv.accept()
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    def _client(self, c):
        try:
            if not self._handshake(c):
                c.close()
                return
        except OSError:
            c.close()
            return
        with self.lock:
            old, self.conn = self.conn, c
            self.lock.notify_all()
        if old is not None:
            try:
                old.close()
            except OSError:
                pass
        log("LotCAD web connected")
        try:
            buf = b""
            parts = []
            while True:
                op, fin, payload, buf = self._read_frame(c, buf)
                if op is None:
                    break
                if op == 8:      # close
                    break
                if op == 9:      # ping -> pong
                    self._send_frame(c, 10, payload)
                    continue
                if op in (1, 0):
                    parts.append(payload)
                    if fin:
                        self._on_message(b"".join(parts))
                        parts = []
        except OSError:
            pass
        with self.lock:
            if self.conn is c:
                self.conn = None
                log("LotCAD web disconnected")
            self.lock.notify_all()
        try:
            c.close()
        except OSError:
            pass

    def _handshake(self, c):
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = c.recv(4096)
            if not chunk or len(data) > 65536:
                return False
            data += chunk
        head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
        headers = {}
        for line in head[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        key = headers.get("sec-websocket-key")
        if headers.get("upgrade", "").lower() != "websocket" or not key:
            c.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            return False
        if not origin_allowed(headers.get("origin", "")):
            log("refused a connection from", headers.get("origin"))
            c.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return False
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        c.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        return True

    def _need(self, c, buf, n):
        while len(buf) < n:
            chunk = c.recv(1 << 20)
            if not chunk:
                raise OSError("closed")
            buf += chunk
        return buf

    def _read_frame(self, c, buf):
        try:
            buf = self._need(c, buf, 2)
        except OSError:
            return None, True, b"", buf
        b0, b1 = buf[0], buf[1]
        fin = bool(b0 & 0x80)
        op = b0 & 0x0F
        masked = bool(b1 & 0x80)
        n = b1 & 0x7F
        pos = 2
        if n == 126:
            buf = self._need(c, buf, 4)
            n = struct.unpack(">H", buf[2:4])[0]
            pos = 4
        elif n == 127:
            buf = self._need(c, buf, 10)
            n = struct.unpack(">Q", buf[2:10])[0]
            pos = 10
        mask = b""
        if masked:
            buf = self._need(c, buf, pos + 4)
            mask = buf[pos:pos + 4]
            pos += 4
        buf = self._need(c, buf, pos + n)
        payload = buf[pos:pos + n]
        if masked:
            payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        return op, fin, payload, buf[pos + n:]

    def _send_frame(self, c, op, payload):
        n = len(payload)
        if n < 126:
            head = struct.pack(">BB", 0x80 | op, n)
        elif n < 65536:
            head = struct.pack(">BBH", 0x80 | op, 126, n)
        else:
            head = struct.pack(">BBQ", 0x80 | op, 127, n)
        with self.send_lock:
            c.sendall(head + payload)

    def _on_message(self, raw):
        try:
            msg = json.loads(raw.decode("utf-8"))
        except ValueError:
            return
        rid = msg.get("id")
        if rid is None:
            return   # 인사 · pong
        with self.lock:
            self.replies[rid] = msg
            self.lock.notify_all()

    def forward(self, raw):
        """중계 - 줄 하나를 앱에 그대로 (답을 기다리지 않는다). 앱이 없으면 버린다."""
        with self.lock:
            c = self.conn
        if c is None:
            return False
        try:
            self._send_frame(c, 1, raw)
        except OSError:
            return False
        return True

    # ── 요청 ──
    def connected(self):
        with self.lock:
            return self.conn is not None

    def request(self, msg, timeout=TIMEOUT):
        """msg 에 id 를 붙여 보내고 답(dict)을 돌려준다. 붙은 앱이 없거나 답이 없으면 ConnectionError."""
        with self.lock:
            if self.conn is None:
                self.lock.wait(2.0)   # 막 다시 붙는 중일 수 있다
            c = self.conn
            if c is None:
                raise ConnectionError("not connected")
            rid = self.next_id
            self.next_id += 1
        self._send_frame(c, 1, json.dumps(dict(msg, id=rid), ensure_ascii=False).encode("utf-8"))
        with self.lock:
            ok = self.lock.wait_for(lambda: rid in self.replies or self.conn is not c, timeout)
            if rid in self.replies:
                return self.replies.pop(rid)
        raise ConnectionError("no answer" if not ok else "disconnected")


BROWSER = Browser()

STATUS_TOOL = {
    "name": "engine_status",
    "description": "Is LotCAD web connected to this bridge? If not, says how to connect (the app runs `link on`). The CAD tools are always listed; they work once the app is connected.",
    "inputSchema": {"type": "object", "properties": {}},
}


# CAD 도구 정의의 사본 (원본은 앱 src/app/lot_app_mcp_tools.cpp mcpToolList, tools/mcpb/server/index.js 와 같은 것).
# 앱이 붙기 전에도 tools/list 에 늘 낸다 - 클라이언트는 목록을 처음 한 번만 읽는다 (listChanged 없음).
# 앱의 정의를 바꾸면 여기도 (회귀 mcp-link 가 웹이 낸 목록과 같은지 본다).
CAD_TOOLS = [
    {"name":"get_scene","description":"Summary of the whole document: object count, kinds, layers, bounds (Z up, units field mm or m) and the first objects (id, kind, layer, center, size, radius/length/text). Read this first.","inputSchema":{"type":"object","properties":{"max_objects":{"type":"integer","description":"objects listed (default 50)"}},"required":[]}},
    {"name":"get_object","description":"Full JSON of one object: kind, layer, transform, bounds and kind-specific geometry in world units (line start/end, circle center/radius, polyline points, dimension value, feature history ...).","inputSchema":{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}},
    {"name":"query_objects","description":"Find object ids with a filter: {\"kind\":\"circle\"|[..], \"layer\":name|id, \"selected\":true, \"visible\":true, \"within\":{\"min\":[x,y,z],\"max\":[..]}, \"intersects\":{..}, \"near\":{\"point\":[x,y,z],\"radius\":r}, \"name\":\"glob*\", \"pick\":\"largest\"|\"smallest\", \"limit\":N}.","inputSchema":{"type":"object","properties":{"filter":{"type":"object"}},"required":["filter"]}},
    {"name":"select","description":"Set the selection (most edit commands act on it). Empty ids clears it. additive=true adds to it.","inputSchema":{"type":"object","properties":{"ids":{"type":"array","items":{"type":"integer"}},"additive":{"type":"boolean"}},"required":["ids"]}},
    {"name":"set_property","description":"Set one property by the same keys get_object returns (color [r,g,b] 0..1, visible, layer, position, scale, radius, start/end, points, closed, text, height, precision, rotation [x,y,z,w], linetype name|id|bylayer, linetypeScale, metallic, opacity, texture = a material library name: bricks Bricks104_4K-PNG_Color, tiles Tiles_Stone_005_basecolor, asphalt, concrete_smooth, fabric_cotton_white, fabric_denim, fabric_gingham_red, fabric_linen_grey, fabric_velvet_blue, leather_brown, marble_grey, metal_brushed_steel, metal_rusted (metal names shade as metal), plaster_white, plastic_grey, wood_dark_walnut, wood_floor_oak, wood_oak_veneer - \"\" removes it ...). World units. One undo step.","inputSchema":{"type":"object","properties":{"id":{"type":"integer"},"key":{"type":"string"},"value":{}},"required":["id","key","value"]}},
    {"name":"run_command","description":"Type one line into the AutoCAD-style command line, exactly as a user would, then Enter. Commands that wait for values take them in the next calls, e.g. \"circle\" -> \"0,0\" -> \"20\"; while waiting, text is a value, not a new command, and an empty text finishes the tool. cancel=true presses ESC (cancel the waiting command / tool). Examples: line, rec, circle, move, extrude, fillet, dli, undo, redo, zoom. The reply has the prompt the command is waiting on.","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"cancel":{"type":"boolean","description":"press ESC instead of typing"}},"required":[]}},
    {"name":"ai_actions","description":"Run structured CAD actions (same contract as the in-app AI command line): create_primitive (world units, position = base centre, solid sits on it in +Z: cube size [x,y,z]; wedge size [x,y,z]; sphere/torus radius (+minor_radius); cylinder/cone radius+height; pyramid radius+height+sides; tube radius+inner_radius+height), draw_sketch (line/circle/arc/ellipse/spline/polyline/rectangle/polygon/leader), edit_selected (select/move/copy/rotate/scale/color/delete/set/pushpull/fillet/chamfer/remove_feature/join/offset/mirror/trim/extend/hatch with ids or filter; pushpull: distance + face \"+x\"|\"-z\".. (the end face on that world side) or point [x,y,z] near the face), view_control, analyze, command. One undo step for the whole list. Returns what each action did.","inputSchema":{"type":"object","properties":{"actions":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","enum":["create_primitive","draw_sketch","edit_selected","view_control","file","create_room","analyze","create_floorplan","command","create_wall_graph","explode"]},"op":{"type":"string","enum":["move","copy","rotate","scale","color","delete","select","deselect","select_all","clear_all","set","pushpull","fillet","chamfer","remove_feature","meshfix","meshsmooth","meshdecimate","meshstitch","thicken","remesh","array3d","stretch","lengthen","break","union","intersect","subtract","hatch","shell","join","offset","mirror","trim","extend","interference","meshcheck","zoom_extents","zoom_to_last","top","front","right","iso","plan","ortho","perspective","grid_on","grid_off","light_on","light_off","light_toggle","style_shaded","style_shaded_edge","style_wireframe","style_wireframe_edge","style_hidden_line","open","save","import","plot","status","solve","auto","clear","amount","play","back","part","spin","balloons","bom","manual"]}},"required":["type"]}}},"required":["actions"]}},
    {"name":"feature_dimensions","description":"Dimensions that built a solid (box width/length/height, cylinder diameter/height, extrude height + sketch circle diameters, rectangle width/length, each edge of other polygon profiles, and hole/boss locations = distance from the profile edges to a circle's centre). Without index/value: list them, plus the extrude's cuts (holes) and bosses. With index and value: change one and the solid is rebuilt (one undo step; a location change moves the hole). remove_cuts / remove_bosses (index lists): delete those holes/bosses in one undo step (indices from the cuts/bosses lists, before removal). A value the solid can't be rebuilt with (hole pushed off the plate) is refused with the reason.","inputSchema":{"type":"object","properties":{"id":{"type":"integer"},"index":{"type":"integer"},"value":{"type":"number"},"remove_cuts":{"type":"array","items":{"type":"integer"}},"remove_bosses":{"type":"array","items":{"type":"integer"}}},"required":["id"]}},
    {"name":"wind_tunnel","description":"Wind tunnel (lattice Boltzmann on the GPU) around solids; wind blows along +X. ops: status (read first: active, steps, drag_coefficient, cells, field, plane, iso_triangles, pipe_openings); start (ids|id = solids, grid fast|normal|fine, wind 0.01..0.12 lattice units, pipe true = flow inside a pipe whose ends are flat ring faces, the end furthest -X is the inlet) - poll status while steps grow (drag settles after a few thousand steps); stop; reset; pause; play; view (field speed|pressure|vortex|smoke, plane x|y|z, at 0..1, smoke|surface|arrows true|false, iso true|false or 0..1 = the surface where the speed is that fraction of the wind, slow inside); wind (value - changes the inlet speed live). Check the picture with capture_view.","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["status","start","stop","reset","pause","play","view","wind"]},"ids":{"type":"array","items":{"type":"integer"}},"id":{"type":"integer"},"grid":{"type":"string","enum":["fast","normal","fine"]},"wind":{"type":"number"},"value":{"type":"number"},"field":{"type":"string","enum":["speed","pressure","vortex","smoke"]},"plane":{"type":"string","enum":["x","y","z"]},"at":{"type":"number"},"smoke":{"type":"boolean"},"surface":{"type":"boolean"},"arrows":{"type":"boolean"},"iso":{},"pipe":{"type":"boolean"}},"required":["op"]}},
    {"name":"water","description":"Water sloshing in a container (a closed solid; GPU free-surface lattice Boltzmann). ops: status (active, steps, mass_drift, surface_triangles, tilt, shake, resonance_steps, spilled_fraction); start (id = container, level 0..1 of its height, grid fast|normal|fine, open true = a cup open at the top: its walls are solid and overflowing water runs out onto the floor at its base) - poll status; stop; reset; pause; play; tilt (x, y degrees -90..90 about the X and Y axes: the cup tips over on screen, pivoting on its lowest edge on the table, and turns there over a short time - +x pours toward +Y, +y toward -X; status tilt_now = the angle now); shake (amplitude 0..1 of gravity, period in steps - omit for the first sloshing resonance); float (ids = closed solids to float, density 0.1..0.95 of water); float_off; speed (value 1..4). Check the picture with capture_view.","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["status","start","stop","reset","pause","play","tilt","shake","float","float_off","speed"]},"id":{"type":"integer"},"ids":{"type":"array","items":{"type":"integer"}},"level":{"type":"number"},"grid":{"type":"string","enum":["fast","normal","fine"]},"open":{"type":"boolean"},"x":{"type":"number"},"y":{"type":"number"},"amplitude":{"type":"number"},"period":{"type":"number"},"density":{"type":"number"},"value":{"type":"number"}},"required":["op"]}},
    {"name":"structural_analysis","description":"Finite-element analysis of one closed solid (quadratic tetrahedra; mm, N, MPa). Flow: open {id} -> status lists faces (index, area, centroid, normal; split at 30 deg edges) -> fix {face} + loads -> run (solves at once in the web version) -> result. face = index, a point [x,y,z] near that face, or \"+x\"|\"-x\"|\"+y\"|\"-y\"|\"+z\"|\"-z\" (the end face on that side). ops: status, open, close, clear (conditions and result), run, set (type stress|heat|modal|buckling, material steel|aluminum|stainless|titanium|abs, size fast|normal|fine, units mm|m (scene unit), modes 1..30, show stress|disp|temp|flux|mode K, animate), fix|free {face}, force {face, force [fx,fy,fz] N over the face}, pressure {face, value MPa, + pushes in}, heat: temp {face, value C}, flux {face, value W in}, convect {face, h W/m2K, ambient C}. Result: stress = max_von_mises_mpa, max_displacement_mm, safety_factor (yield / max stress), reaction_n; heat = temperatures, face_heat; modal = frequencies_hz; buckling = load_factors (applied load x factor = buckling load).","inputSchema":{"type":"object","properties":{"op":{"type":"string","enum":["status","open","close","clear","run","set","fix","free","force","pressure","temp","flux","convect"]},"id":{"type":"integer"},"face":{},"force":{"type":"array","items":{"type":"number"}},"value":{"type":"number"},"h":{"type":"number"},"ambient":{"type":"number"},"type":{"type":"string"},"material":{"type":"string"},"size":{"type":"string"},"units":{"type":"string"},"modes":{"type":"integer"},"show":{"type":"string"},"animate":{"type":"boolean"}},"required":["op"]}},
    {"name":"capture_view","description":"Screenshot of the current viewport as an image, so you can check the result visually. clean=true hides the grid. max_size = longest side in px (default 1280).","inputSchema":{"type":"object","properties":{"clean":{"type":"boolean"},"max_size":{"type":"integer"}},"required":[]}},
]

def list_tools():
    """engine_status + CAD 도구 전부. 앱이 붙어 있으면 앱의 목록이 먼저, 고정 목록에만 있는 것은 뒤에."""
    web = []
    if BROWSER.connected():
        try:
            web = BROWSER.request({"type": "tools"}, 10).get("tools", [])
        except ConnectionError as e:
            log("tools/list: app not connected:", e)
    names = {t.get("name") for t in web}
    return [STATUS_TOOL] + web + [t for t in CAD_TOOLS if t["name"] not in names]


def not_connected():
    if BROWSER.listen_error:
        t = (f"LotCAD cannot connect: port {PORT} on this computer is already used by another program ({BROWSER.listen_error}). "
             "The installed LotCAD desktop app uses the same port - if it is running, close it and restart this bridge, then try again.")
    else:
        t = NOT_CONNECTED.format(host=HOST, port=PORT)
    return {"content": [{"type": "text", "text": t}], "isError": True}


def call_tool(name, args):
    if name == "engine_status":
        if BROWSER.connected():
            return {"content": [{"type": "text", "text": "connected"}], "isError": False}
        return not_connected()
    try:
        reply = BROWSER.request({"type": "call", "tool": name, "args": args or {}})
    except ConnectionError:
        return not_connected()
    return {"content": reply.get("content", []), "isError": bool(reply.get("isError", False))}


def handle(msg):
    """JSON-RPC 요청 하나 -> 답(dict) 또는 None(알림)."""
    method = msg.get("method")
    mid = msg.get("id")
    params = msg.get("params") or {}
    if mid is None:
        return None
    if method == "initialize":
        result = {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": INSTRUCTIONS,
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": list_tools()}
    elif method == "tools/call":
        result = call_tool(params.get("name", ""), params.get("arguments") or {})
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def relay_serve(port):
    """자세 중계 - tag_tracker.py · 로봇이 네이티브 앱 (TCP) 에 보내듯 여기에 보내면 앱의 WebSocket 으로 넘긴다."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((HOST, port))
    except OSError as e:
        log(f"relay: cannot listen on {HOST}:{port}: {e}")
        return
    srv.listen(4)
    log(f"relay: pose lines on tcp {HOST}:{port} -> LotCAD web")
    while True:
        c, _ = srv.accept()
        threading.Thread(target=relay_client, args=(c,), daemon=True).start()


def relay_client(c):
    buf = b""
    dropped = 0
    try:
        while True:
            d = c.recv(65536)
            if not d:
                break
            buf += d
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except ValueError:
                    continue
                if not isinstance(msg, dict) or msg.get("type") not in RELAY_TYPES:
                    continue
                if not BROWSER.forward(line):
                    dropped += 1
                    if dropped == 1:
                        log("relay: LotCAD web is not connected - dropping (type `link` in the app)")
                else:
                    dropped = 0
    except OSError:
        pass
    try:
        c.close()
    except OSError:
        pass


def main():
    relay = RELAY
    if "--relay" in sys.argv:
        i = sys.argv.index("--relay")
        relay = int(sys.argv[i + 1]) if i + 1 < len(sys.argv) and sys.argv[i + 1].isdigit() else 7700
    threading.Thread(target=BROWSER.serve, daemon=True).start()
    if relay:
        threading.Thread(target=relay_serve, args=(relay,), daemon=True).start()
        if sys.stdin.isatty():   # 터미널에서 중계만 - MCP 클라이언트가 없다
            threading.Event().wait()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        else:
            try:
                out = handle(msg)
            except Exception as e:   # 브리지가 죽지 않게 — 오류는 답으로
                log("error:", repr(e))
                out = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32603, "message": str(e)}}
        if out is not None:
            sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
