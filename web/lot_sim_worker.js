// 구조 해석 모듈의 Worker 입구. 본체 (src/js/lot_sim_link.js) 가 처음 sim run 할 때 new Worker('lot_sim_worker.js').
//   받는 것: { id, bytes: ArrayBuffer (일감 - sim/lot_sim_job) }
//   돌려주는 것: { id, progress: [단계, 비율] } (도는 동안) · { id, ok, bytes?: ArrayBuffer (결과), message }
// 멈춤은 본체가 Worker 를 통째로 끝낸다 (terminate) - 다음 일감에 새로 띄운다.
// 주소 꼬리 (?v=빌드 번호) 를 모듈 JS · wasm 에도 붙인다 - 새로 올리면 캐시의 옛것 대신 새것
var version = self.location.search || '';
importScripts('lot_sim.js' + version);

var ready = createLotSim({ 'locateFile': function(path) { return path + version; } });

self.onmessage = function(e) {
    var req = e.data;
    ready.then(function(M) {
        M['lotProgress'] = function(stage, fraction) { self.postMessage({ 'id': req['id'], 'progress': [stage, fraction] }); };
        var data = new Uint8Array(req['bytes']);
        var src = M._malloc(Math.max(1, data.length));
        M.HEAPU8.set(data, src);
        var lenPtr = M._malloc(4);
        var out = M._lot_simRun(src, data.length, lenPtr);
        M._free(src);
        var n = M.HEAP32[lenPtr >> 2];
        M._free(lenPtr);
        if (!out) { self.postMessage({ 'id': req['id'], 'ok': false, 'message': 'sim: out of memory in the analysis module' }); return; }
        var bytes = M.HEAPU8.slice(out, out + n).buffer;
        M._free(out);
        self.postMessage({ 'id': req['id'], 'ok': true, 'bytes': bytes }, [bytes]);
    }).catch(function(err) {
        self.postMessage({ 'id': req['id'], 'ok': false, 'message': 'sim: the analysis module failed - ' + err });
    });
};
