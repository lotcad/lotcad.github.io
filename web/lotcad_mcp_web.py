#!/usr/bin/env python3
"""LotCAD 웹 MCP 브리지 — MCP 클라이언트(Claude Desktop · Claude Code 등)와 브라우저에서 도는 LotCAD 웹 앱을 잇는다.

네이티브 tools/lotcad_mcp.py 와 같은 일을 하되, 브라우저는 접속을 받을 수 없으므로 방향이 반대다:
브리지가 127.0.0.1:7700 에서 WebSocket 을 열고, 웹 앱이 명령행 `link on` 으로 거기에 붙는다.
메시지는 네이티브 link 와 같다 — {"type":"tools","id":n} -> {"type":"tools","id":n,"tools":[…]},
{"type":"call","tool":…,"args":{…},"id":n} -> {"type":"result","id":n,"content":[…],"isError":bool}.
도구 정의는 앱 한 곳(src/app/lot_app_mcp_tools.cpp)에 있고 여기는 전달만 한다.

쓰는 법
  1) MCP 클라이언트에 등록한다.
       Claude Code:     claude mcp add lotcad -- python3 /절대/경로/lotcad_mcp_web.py
       Claude Desktop:  claude_desktop_config.json 에
                        {"mcpServers": {"lotcad": {"command": "python3", "args": ["/절대/경로/lotcad_mcp_web.py"]}}}
  2) 브라우저에서 LotCAD 웹을 열고 명령행에 `link on` (브리지가 아직 없으면 앱이 몇 초마다 다시 붙는다).
  3) "머그컵 만들어 줘" — 모델이 get_scene · ai_actions · run_command · capture_view 로 만들고 화면을 확인한다.

환경 변수: LOTCAD_PORT (기본 7700), LOTCAD_TIMEOUT (초, 기본 60),
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

PORT = int(os.environ.get("LOTCAD_PORT", "7700"))
HOST = "127.0.0.1"
TIMEOUT = float(os.environ.get("LOTCAD_TIMEOUT", "60"))
ORIGINS = [o.strip() for o in os.environ.get("LOTCAD_ORIGINS", "https://lotcad.github.io").split(",") if o.strip()]
SERVER_INFO = {"name": "lotcad-web", "version": "0.1.0"}
INSTRUCTIONS = (
    "LotCAD is a CAD engine running in a browser (Z up; units are the document's, see get_scene units). Start with "
    "get_scene. Build with ai_actions or run_command (AutoCAD-style command line: a command, then its values in following "
    "calls). Check results with capture_view (image) and get_object. Everything is undoable with run_command \"undo\"."
)
NOT_CONNECTED = (
    "LotCAD web is not connected to this bridge (ws://{host}:{port}). Open LotCAD in the browser and type `link on` in its "
    "command line (`link port N` if LOTCAD_PORT is not 7700)."
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

    # ── WebSocket 서버 ──
    def serve(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind((HOST, PORT))
        except OSError as e:
            log(f"cannot listen on {HOST}:{PORT}: {e}")
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
    "description": "LotCAD web is not connected yet. Call this to see how to connect; the CAD tools appear after the app runs `link on`.",
    "inputSchema": {"type": "object", "properties": {}},
}


def list_tools():
    try:
        return BROWSER.request({"type": "tools"}).get("tools", [])
    except ConnectionError as e:
        log("tools/list: app not connected:", e)
        return [STATUS_TOOL]


def call_tool(name, args):
    if name == "engine_status":
        if BROWSER.connected():
            return {"content": [{"type": "text", "text": "connected — call tools/list again for the CAD tools"}], "isError": False}
        return {"content": [{"type": "text", "text": NOT_CONNECTED.format(host=HOST, port=PORT)}], "isError": True}
    try:
        reply = BROWSER.request({"type": "call", "tool": name, "args": args or {}})
    except ConnectionError:
        return {"content": [{"type": "text", "text": NOT_CONNECTED.format(host=HOST, port=PORT)}], "isError": True}
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


def main():
    threading.Thread(target=BROWSER.serve, daemon=True).start()
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
