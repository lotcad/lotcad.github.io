// 예제 플러그인 - 벽 (네이티브 lot_plugin_sdk.h 의 HelloPlugin 'wall' 과 같은 것).
//
//   pload plugins/hello_wall.js     붙이기 (설정 메뉴 '플러그인 불러오기' 로 파일을 골라도 된다)
//   wall                            벽 하나 (길이 3 · 높이 2.5 · 두께 0.2) - 고른 것이 있으면 그 옆에
//   punload HelloWall               내리기 (명령 · 리본 단추 · 속성은 엔진이 지운다)
//
// 벽은 평범한 메시에 딱지 (owner HelloWall, type wall, data {length, height, thick}) 를 붙인 것이다:
// 속성 창에서 값을 고치면 onEntityChanged 가 와서 메시를 다시 만든다. .lot 에 저장되고, 플러그인 없이 열어도
// 형상은 보인다 (값은 읽기 전용). 다시 붙이면 그대로 살아난다.

export const abiVersion = 1;
export const name = 'HelloWall';

let api = null;

// 상자 메시 (객체 로컬): x 0..L, y -T/2..T/2, z 0..H
function wallMesh(d) {
    const L = d.length, H = d.height, T = d.thick / 2;
    const p = [
        0, -T, 0,   L, -T, 0,   L, T, 0,   0, T, 0,
        0, -T, H,   L, -T, H,   L, T, H,   0, T, H,
    ];
    const f = [
        0, 2, 1, 0, 3, 2,   4, 5, 6, 4, 6, 7,   // 바닥 · 위
        0, 1, 5, 0, 5, 4,   2, 3, 7, 2, 7, 6,   // 앞 · 뒤
        1, 2, 6, 1, 6, 5,   3, 0, 4, 3, 4, 7,   // 오른쪽 · 왼쪽
    ];
    return { positions: p, indices: f, smooth: 0 };
}

function clean(d) {
    const num = (v, def) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : def);
    return { length: num(d && d.length, 3), height: num(d && d.height, 2.5), thick: num(d && d.thick, 0.2) };
}

function makeWall() {
    const d = clean({});
    let at = [0, 0, 0];
    const sel = api.selection();
    if (sel.length) {   // 고른 것의 오른쪽 끝에 이어서
        const o = api.object(sel[0]);
        if (o && o.bounds) at = [o.bounds.max[0], o.bounds.min[1] + (o.bounds.max[1] - o.bounds.min[1]) / 2, o.bounds.min[2]];
    }
    api.transaction('wall', () => {
        const id = api.createMesh(Object.assign(wallMesh(d), { color: [0.85, 0.78, 0.66], position: at }));
        if (id < 0) { api.log('could not make the wall mesh'); return; }
        api.setTag(id, 'wall', d);
        api.select([id]);
        api.log('wall #' + id + ' ' + d.length + ' x ' + d.height + ' x ' + d.thick);
    });
}

export function load(a) {
    api = a;
    if (!api.registerCommand('wall', '벽', makeWall)) return false;
    api.addRibbonButton('건축/벽체', '벽', 'wall', '▭');
    api.addMenuItem('건축', '벽 만들기', 'wall', '▭');
    api.addEntityProperty('wall', 'length', '길이', 'float', 0.1, 100);
    api.addEntityProperty('wall', 'height', '높이', 'float', 0.1, 50);
    api.addEntityProperty('wall', 'thick', '두께', 'float', 0.05, 2);
    // 속성 창에서 값을 고쳤다 - 같은 자리에서 형상만 다시 (실행 취소 한 번에 값과 같이 묶인다)
    api.onEntityChanged((e) => { if (e.type === 'wall') api.replaceMesh(e.id, wallMesh(clean(e.data))); });
    // .lot 을 열었다 / 늦게 붙었다 - 저장된 형상 그대로라 할 일이 없다 (값이 이상하면 바로잡을 자리)
    api.onEntityLoaded((e) => { if (e.type === 'wall') api.log('wall #' + e.id + ' ready'); });
    return true;
}

export function unload() { api = null; }
