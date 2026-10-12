// DWG 모듈의 Worker 입구. 본체 (src/js/lot_files.js) 가 처음 DWG 를 열거나 저장할 때 new Worker('lot_dwg_worker.js').
//   받는 것: { id, op: 'dwg2dxf', bytes: ArrayBuffer }  /  { id, op: 'dxf2dwg', text: string }
//   돌려주는 것: { id, ok, bytes?: ArrayBuffer, text?: string, message }
// 주소 꼬리 (?v=빌드 번호) 를 모듈 JS · wasm 에도 붙인다 - 새로 올리면 캐시의 옛것 대신 새것
var version = self.location.search || '';
importScripts('lot_dwg.js' + version);

var ready = createLotDwg({ 'locateFile': function(path) { return path + version; } });

function run(M, fn, data, len) {
    var src = M._malloc(Math.max(1, len));
    M.HEAPU8.set(data, src);
    var lenPtr = M._malloc(4);
    var out = fn(src, len, lenPtr);
    M._free(src);
    var n = M.HEAP32[lenPtr >> 2];
    M._free(lenPtr);
    var message = M.UTF8ToString(M._lot_dwgMessage());
    if (!out) return { ok: false, message: message };
    var bytes = M.HEAPU8.slice(out, out + n);
    M._free(out);
    return { ok: true, bytes: bytes, message: message };
}

self.onmessage = function(e) {
    var req = e.data;
    ready.then(function(M) {
        var res;
        if (req.op === 'dwg2dxf') {
            res = run(M, M._lot_dwgToDxf, new Uint8Array(req.bytes), req.bytes.byteLength);
            if (res.ok) { res.text = new TextDecoder('utf-8').decode(res.bytes); delete res.bytes; }
        } else if (req.op === 'dxf2dwg') {
            var text = new TextEncoder().encode(req.text);
            res = run(M, M._lot_dxfToDwg, text, text.length);
            if (res.ok) res.bytes = res.bytes.buffer;
        } else {
            res = { ok: false, message: 'unknown op ' + req.op };
        }
        res.id = req.id;
        self.postMessage(res, res.bytes ? [res.bytes] : []);
    }).catch(function(err) {
        self.postMessage({ id: req.id, ok: false, message: 'DWG module failed to start: ' + err });
    });
};
