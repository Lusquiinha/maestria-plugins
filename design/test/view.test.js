'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const view = require('../lib/view');

const HASH = 'abc123def456';
const canvas = {
  title: 'toasts',
  boards: { a: { x: 0, y: 0, w: 1280 }, b: { x: 1360, y: 0, w: 400, title: 'Toast pequeno' } },
  order: ['a', 'b'],
  warnings: [],
};
const st = (name, w, h, extra = {}) => ({
  light: `/data/${HASH}/png/${name}.light.png`, dark: `/data/${HASH}/png/${name}.dark.png`, width: w, height: h, cut: false, rev: 3, ...extra,
});
const states = new Map([['a', st('a', 1280, 200)], ['b', st('b', 400, 100)]]);
const ui = (o = {}) => ({ theme: 'both', follow: true, highlight: null, command: null, rev: 0, ...o });
const CAPS = { picture: 1, zoomFocus: 1 };
const build = (o = {}) => view.build({ canvas, states, ui: ui(o.ui), caps: o.caps || CAPS, hash: HASH, ...o.extra });

function noNull(v, where = 'data') {
  assert.ok(v !== null && v !== undefined, `${where} is ${v}`);
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `${where} is ${v}`);
  if (Array.isArray(v)) v.forEach((x, i) => noNull(x, `${where}.${i}`));
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) noNull(x, `${where}.${k}`);
}

test('theme both: box = 2w + 24, laid out without overlap', () => {
  const d = build();
  const [a, b] = d.boards;
  assert.strictEqual(a.name, 'a');
  assert.strictEqual(a.width, 2584);
  assert.strictEqual(b.width, 824);
  assert.strictEqual(b.left, a.left + 2584 + 80);
  assert.strictEqual(a.left, 80);
  assert.strictEqual(a.top, 80);
  assert.strictEqual(a.height, 28 + 200);
  assert.deepStrictEqual(d.size, { w: 80 + 2584 + 80 + 824 + 80, h: 80 + 228 + 80 });
  assert.strictEqual(a.light, `${HASH}/png/a.light.png`);
  assert.strictEqual(a.dark, `${HASH}/png/a.dark.png`);
  assert.strictEqual(d.title, 'toasts');
  assert.strictEqual(d.theme, 'both');
  assert.strictEqual(d.picture, true);
  noNull(d);
});

test('theme light / dark: box = w, only that image', () => {
  const l = build({ ui: { theme: 'light' } });
  assert.deepStrictEqual(l.boards.map((b) => b.width), [1280, 400]);
  assert.strictEqual(l.boards[1].left, l.boards[0].left + 1360);
  assert.strictEqual(l.boards[0].light, `${HASH}/png/a.light.png`);
  assert.strictEqual(l.boards[0].dark, '');
  const d = build({ ui: { theme: 'dark' } });
  assert.deepStrictEqual(d.boards.map((b) => b.width), [1280, 400]);
  assert.strictEqual(d.boards[0].light, '');
  assert.strictEqual(d.boards[0].dark, `${HASH}/png/a.dark.png`);
});

test('a board with an error keeps its last images and shows the error', () => {
  const s = new Map(states);
  s.set('b', st('b', 400, 100, { error: 'marcação inválida: <div> sem fechar' }));
  const d = view.build({ canvas, states: s, ui: ui(), caps: CAPS, hash: HASH });
  const b = d.boards[1];
  assert.strictEqual(b.error, 'marcação inválida: <div> sem fechar');
  assert.strictEqual(b.light, `${HASH}/png/b.light.png`);
  assert.strictEqual(b.dark, `${HASH}/png/b.dark.png`);
  assert.strictEqual(d.boards[0].error, '');
  noNull(d);
});

test('a board not rendered yet has no images and a placeholder height', () => {
  const d = view.build({ canvas, states: new Map(), ui: ui(), caps: CAPS, hash: HASH });
  assert.strictEqual(d.boards[0].light, '');
  assert.strictEqual(d.boards[0].dark, '');
  assert.ok(d.boards[0].imageHeight > 0);
  noNull(d);
});

test('states may be a plain object', () => {
  const d = view.build({ canvas, states: Object.fromEntries(states), ui: ui(), caps: CAPS, hash: HASH });
  assert.strictEqual(d.boards[0].imageHeight, 200);
});

test('focus command: rect as fractions of the canvas, within 0..1', () => {
  const d = build({ ui: { command: { kind: 'focus', board: 'b' }, rev: 4 } });
  assert.strictEqual(d.zoom.command, 'focus');
  assert.strictEqual(d.zoom.rev, 4);
  const f = d.zoom.focus;
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(f[k] >= 0 && f[k] <= 1, `${k}=${f[k]}`);
  const b = d.boards[1];
  assert.ok(Math.abs(f.x * d.size.w - b.left) < 1e-6);
  assert.ok(Math.abs(f.w * d.size.w - b.width) < 1e-6);
  assert.ok(Math.abs(f.y * d.size.h - b.top) < 1e-6);
  assert.ok(Math.abs(f.h * d.size.h - b.height) < 1e-6);
  noNull(d);
});

test('focus with an explicit rect (canvas coords) and in/out/fit pass through', () => {
  const d = build({ ui: { command: { kind: 'focus', rect: { x: 80, y: 80, w: 100, h: 50 } }, rev: 1 } });
  assert.ok(Math.abs(d.zoom.focus.x * d.size.w - 80) < 1e-6);
  for (const kind of ['in', 'out', 'fit']) {
    assert.strictEqual(build({ ui: { command: { kind }, rev: 2 } }).zoom.command, kind);
  }
  assert.strictEqual(build().zoom.command, '');
});

test('without zoomFocus the focus command falls back to fit', () => {
  const d = build({ caps: { picture: 1 }, ui: { command: { kind: 'focus', board: 'a' }, rev: 2 } });
  assert.strictEqual(d.zoom.command, 'fit');
  assert.strictEqual(d.zoom.rev, 2);
});

test('without picture: sprite sheets copied into the plugin cache, per rev', () => {
  const d = build({ caps: { zoomFocus: 1 } });
  assert.strictEqual(d.picture, false);
  assert.strictEqual(d.boards[0].light, `cache/${HASH}/a.light.3.png`);
  assert.strictEqual(d.boards[0].dark, `cache/${HASH}/a.dark.3.png`);
  noNull(d);
});

test('highlight flags only the named board', () => {
  const d = build({ ui: { highlight: 'b', scale: 1.5 } });
  assert.deepStrictEqual(d.boards.map((b) => b.highlight), [false, true]);
});

test('one menu: tema, seguir o claude and the boards; no zoom data', () => {
  const d = build();
  assert.strictEqual(d.boards[0].focus, 'focus:a');
  for (const k of ['zoomLabel', 'themeLabel', 'themeMenu', 'listMenu', 'list']) assert.ok(!(k in d), `${k} still in the data`);
  const acts = d.menu.map((m) => m.action || m.type);
  assert.deepStrictEqual(acts, ['tema:light', 'tema:dark', 'tema:both', 'divider', 'seguir', 'divider', 'focus:a', 'focus:b']);
  const item = (a, m = d.menu) => m.find((x) => x.action === a);
  assert.strictEqual(item('tema:both').icon, 'check'); // the current theme and follow on are checked
  assert.ok(!item('tema:light').icon);
  assert.strictEqual(item('seguir').icon, 'check');
  assert.strictEqual(item('focus:b').label, 'Toast pequeno');
  const off = build({ ui: { theme: 'dark', follow: false } }).menu;
  assert.strictEqual(item('tema:dark', off).icon, 'check');
  assert.ok(!item('seguir', off).icon);
  const empty = view.build({ canvas: { title: 'x', boards: {}, order: [], warnings: [] }, states: new Map(), ui: ui(), caps: CAPS, hash: HASH });
  assert.deepStrictEqual(empty.menu.map((m) => m.action || m.type), ['tema:light', 'tema:dark', 'tema:both', 'divider', 'seguir']);
  noNull(d);
});

test('the toolbar: the title and a single menu, no zoom buttons', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'ui', 'canvas.rfwtxt'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.strictEqual((lib.match(/MenuButton\(/g) || []).length, 1);
  assert.match(lib, /MenuButton\(icon: "more", tooltip: "[^"]+", menu: data\.menu, onMenu: event "act" \{\}\)/);
  for (const gone of ['zoom:in', 'zoom:out', 'zoom:fit', 'ajustar', 'zoomLabel', 'IconButton', 'Follow(']) {
    assert.ok(!lib.includes(gone), `${gone} still in the toolbar`);
  }
});

test('empty canvas still has a size and no nulls', () => {
  const d = view.build({ canvas: { title: 'x', boards: {}, order: [], warnings: [] }, states: new Map(), ui: ui(), caps: CAPS, hash: HASH });
  assert.deepStrictEqual(d.boards, []);
  assert.ok(d.size.w > 0 && d.size.h > 0);
  noNull(d);
});

test('cacheSprites copies the current pngs and deletes older revs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-view-'));
  try {
    const pluginDir = path.join(tmp, 'plugin');
    const png = path.join(tmp, 'data', 'png');
    fs.mkdirSync(png, { recursive: true });
    fs.writeFileSync(path.join(png, 'a.light.png'), 'L');
    fs.writeFileSync(path.join(png, 'a.dark.png'), 'D');
    const s = new Map([['a', { light: path.join(png, 'a.light.png'), dark: path.join(png, 'a.dark.png'), width: 10, height: 10, rev: 2 }]]);
    const cache = path.join(pluginDir, 'cache', HASH);
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'a.light.1.png'), 'old');
    fs.writeFileSync(path.join(cache, 'gone.light.1.png'), 'old');
    view.cacheSprites({ pluginDir, hash: HASH, states: s });
    assert.deepStrictEqual(fs.readdirSync(cache).sort(), ['a.dark.2.png', 'a.light.2.png']);
    assert.strictEqual(fs.readFileSync(path.join(cache, 'a.light.2.png'), 'utf8'), 'L');
    view.clearSprites({ pluginDir, hash: HASH });
    assert.strictEqual(fs.existsSync(cache), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manifest: id, main, activation events, commands', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'maestria-plugin.json'), 'utf8'));
  assert.strictEqual(m.id, 'maestria.design');
  assert.strictEqual(m.name, 'Design');
  assert.strictEqual(m.maestria, 1);
  assert.deepStrictEqual(m.main, ['node', 'main.js']);
  assert.deepStrictEqual(m.activationEvents, ['onCommand:abrir', 'onTool:design_open', 'onTool:design_board', 'onTool:design_render', 'onTool:design_focus', 'onTool:design_list', 'onTool:design_ref', 'onHook:PreToolUse']);
  assert.deepStrictEqual(m.permissions, ['sessions.create', 'hooks']);
  assert.deepStrictEqual(m.contributes.commands, [{ id: 'abrir', title: 'design: abrir' }]);
  assert.ok(fs.existsSync(path.join(__dirname, '..', m.icon)));
});

test('wire: whole numbers become doubles for rfw (json has no 16.0); text and flags untouched', () => {
  const w = view.wire({ a: 80, b: 0, c: 1, d: 2.5, e: 'x', f: true, g: [{ h: 1280 }], zoom: { rev: 3 } });
  for (const v of [w.a, w.b, w.c, w.g[0].h]) assert.ok(!Number.isInteger(v), `${v} is still an int`);
  assert.ok(Math.abs(w.a - 80) < 1e-6 && Math.abs(w.b) < 1e-6 && w.c <= 1 && Math.abs(w.c - 1) < 1e-6);
  assert.strictEqual(w.d, 2.5);
  assert.strictEqual(w.e, 'x');
  assert.strictEqual(w.f, true);
  assert.strictEqual(w.zoom.rev, 3); // commandRev reads ints
  const text = JSON.stringify(view.wire(build({ ui: { command: { kind: 'focus', board: 'a' }, rev: 1 } }))).replace(/"rev":\d+/g, '');
  assert.ok(!/[:[,]-?\d+[,}\]]/.test(text), `an int slipped through: ${text}`);
});

test('frameWidth fixes the Positioned width: box plus the 2 px border on each side', () => {
  const d = build();
  assert.deepStrictEqual(d.boards.map((b) => b.frameWidth), [2588, 828]);
});

test('scans: canvas px over each shown image, clipped to it; none by default', () => {
  assert.deepStrictEqual(build().scans, []);
  const rect = { x: 10, y: 20, w: 100, h: 40 };
  const d = build({ extra: { scans: [{ board: 'a', rect: null }, { board: 'b', rect }, { board: 'gone', rect: null }] } });
  const [a, b] = d.boards;
  const top = (x) => x.top + 2 + 28; // border, then the name strip
  assert.deepStrictEqual(d.scans, [
    { left: a.left + 2, top: top(a), width: 1280, height: 200 },
    { left: a.left + 2 + 1280 + 24, top: top(a), width: 1280, height: 200 },
    { left: b.left + 2 + 10, top: top(b) + 20, width: 100, height: 40 },
    { left: b.left + 2 + 400 + 24 + 10, top: top(b) + 20, width: 100, height: 40 },
  ]);
  const dark = build({ ui: { theme: 'dark' }, extra: { scans: [{ board: 'b', rect: { x: 350, y: 90, w: 100, h: 40 } }] } });
  const db = dark.boards[1];
  assert.deepStrictEqual(dark.scans, [{ left: db.left + 2 + 350, top: db.top + 30 + 90, width: 50, height: 10 }]);
  const out = build({ extra: { scans: [{ board: 'b', rect: { x: 500, y: 0, w: 10, h: 10 } }] } });
  assert.deepStrictEqual(out.scans, []);
  noNull(d);
});

// ---- selection (caps zoomPan + keyListener) --------------------------------

const SEL = { picture: 1, zoomFocus: 1, zoomPan: 1, keyListener: 1 };
const nd = (k, x, y, w, h, kind, name, children = []) => ({
  k, rect: { x, y, w, h }, kind, name, file: 'boards/a.html', path: [k], call: null, componentFile: null, children,
});
const NODES = {
  a: { roots: [
    nd(1, 0, 0, 240, 200, 'component', 'sidebar', [nd(3, 10, 20, 200, 30, 'element', 'span'), nd(4, 10, 60, 200, 30, 'element', 'a')]),
    nd(2, 260, 0, 1000, 200, 'element', 'main'),
  ] },
  b: { roots: [nd(1, 5, 5, 100, 50, 'component', 'toast')] },
};
const sel = (o = {}) => build({ caps: o.caps || SEL, ui: o.ui, extra: { nodes: new Map(Object.entries(NODES)), ...o.extra } });
const img = (b) => ({ left: b.left + 2, top: b.top + 2 + 28 }); // the light image's origin in canvas px

test('hits at the top level: the top components of every board, on both copies', () => {
  const d = sel();
  const [a, b] = d.boards;
  const A = img(a);
  const B = img(b);
  const pick = (h) => ({ board: h.board, k: h.k, left: h.left, top: h.top, width: h.width, height: h.height });
  assert.deepStrictEqual(d.hits.map(pick), [
    { board: 'a', k: 1, left: A.left, top: A.top, width: 240, height: 200 },
    { board: 'a', k: 1, left: A.left + 1280 + 24, top: A.top, width: 240, height: 200 },
    { board: 'a', k: 2, left: A.left + 260, top: A.top, width: 1000, height: 200 },
    { board: 'a', k: 2, left: A.left + 260 + 1280 + 24, top: A.top, width: 1000, height: 200 },
    { board: 'b', k: 1, left: B.left + 5, top: B.top + 5, width: 100, height: 50 },
    { board: 'b', k: 1, left: B.left + 5 + 400 + 24, top: B.top + 5, width: 100, height: 50 },
  ]);
  assert.strictEqual(d.hits[0].tap, 'sel:a:1');
  assert.strictEqual(d.hits[0].dbl, 'in:a:1');
  assert.strictEqual(d.select, true);
  assert.deepStrictEqual(d.panButtons, ['middle']);
  assert.deepStrictEqual(d.keys, ['ctrl+c', 'escape', 'ctrl+0', 'ctrl+=', 'ctrl+-']);
  assert.deepStrictEqual(d.selections, []);
  assert.ok(!('selection' in d));
  noNull(d);
});

test('a level opened by double-tap: its children are the hits there; other boards keep their top level', () => {
  const d = sel({ ui: { theme: 'light', level: { board: 'a', k: 1 } } });
  const A = img(d.boards[0]);
  assert.deepStrictEqual(d.hits.map((h) => [h.board, h.k, h.left, h.top]), [
    ['a', 3, A.left + 10, A.top + 20],
    ['a', 4, A.left + 10, A.top + 60],
    ['b', 1, img(d.boards[1]).left + 5, img(d.boards[1]).top + 5],
  ]);
  // a level that went away (re-render) falls back to the top level
  const gone = sel({ ui: { theme: 'light', level: { board: 'a', k: 99 } } });
  assert.deepStrictEqual(gone.hits.map((h) => h.k), [1, 2, 1]);
});

test('selection: blue rect with the name, in canvas px, over both copies in "both"', () => {
  const d = sel({ ui: { sel: { board: 'a', k: 3 }, level: { board: 'a', k: 1 } } });
  const A = img(d.boards[0]);
  const lt = A.top + 20 - 24; // the name sits in a 24 px strip above the rect
  const chrome = { labelH: 24, fontSize: 14, padX: 6, padY: 2, border: 2 };
  assert.deepStrictEqual(d.selection, { left: A.left + 10, top: A.top + 20, width: 200, height: 30, label: 'span', labelTop: lt, ...chrome });
  assert.deepStrictEqual(d.selections, [
    { left: A.left + 10, top: A.top + 20, width: 200, height: 30, label: 'span', labelTop: lt, ...chrome },
    { left: A.left + 10 + 1280 + 24, top: A.top + 20, width: 200, height: 30, label: 'span', labelTop: lt, ...chrome },
  ]);
  const dark = sel({ ui: { theme: 'dark', sel: { board: 'b', k: 1 } } });
  const B = img(dark.boards[1]);
  assert.deepStrictEqual(dark.selections, [{ left: B.left + 5, top: B.top + 5, width: 100, height: 50, label: 'toast', labelTop: B.top + 5 - 24, ...chrome }]);
  const stale = sel({ ui: { sel: { board: 'a', k: 42 } } });
  assert.deepStrictEqual(stale.selections, []);
  noNull(d);
});

test('an old host (no zoomPan/keyListener): no hits, no keys, no panButtons, no selection', () => {
  for (const caps of [CAPS, { ...CAPS, zoomPan: 1 }, { ...CAPS, keyListener: 1 }]) {
    const d = sel({ caps, ui: { sel: { board: 'a', k: 1 } } });
    assert.strictEqual(d.select, false);
    assert.deepStrictEqual(d.hits, []);
    assert.deepStrictEqual(d.selections, []);
    assert.ok(!('panButtons' in d));
    assert.ok(!('selection' in d));
    noNull(d);
  }
});

test('wire keeps hit k as ints', () => {
  const w = view.wire(sel());
  assert.strictEqual(w.hits[0].k, 1);
  assert.ok(!Number.isInteger(w.hits[0].left));
});

test('the canvas ui: KeyListener over the canvas, hits as Pressables, middle-drag pan', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'ui', 'canvas.rfwtxt'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(lib, /KeyListener\(\s*keys: data\.keys,\s*onKey: event "act" \{ a: "key" \}/);
  assert.match(lib, /panButtons: data\.panButtons/);
  assert.match(lib, /onTap: event "act" \{ a: args\.h\.tap \}/);
  assert.match(lib, /onDoubleTap: event "act" \{ a: args\.h\.dbl \}/);
  assert.match(lib, /onTap: event "act" \{ a: "clear" \}/);
  for (const f of ['labelH', 'fontSize', 'padX', 'padY', 'border']) assert.match(lib, new RegExp(`args\\.s\\.${f}`));
});

test('the selected node\'s children are layered over the level: tap keeps the parent, double-click picks the child', () => {
  const d = sel({ ui: { theme: 'light', sel: { board: 'a', k: 1 } } });
  const A = img(d.boards[0]);
  assert.deepStrictEqual(d.hits.map((h) => [h.board, h.k, h.tap, h.dbl]), [
    ['a', 1, 'sel:a:1', 'in:a:1'],
    ['a', 2, 'sel:a:2', 'in:a:2'],
    ['b', 1, 'sel:b:1', 'in:b:1'],
    // later in the Stack = on top
    ['a', 3, 'sel:a:1', 'child:a:3'],
    ['a', 4, 'sel:a:1', 'child:a:4'],
  ]);
  assert.deepStrictEqual([d.hits[3].left, d.hits[3].top, d.hits[3].width], [A.left + 10, A.top + 20, 200]);
  // in "both" the children are on both copies
  assert.strictEqual(sel({ ui: { sel: { board: 'a', k: 1 } } }).hits.filter((h) => h.dbl.startsWith('child:')).length, 4);
  // a leaf adds nothing
  assert.strictEqual(sel({ ui: { sel: { board: 'b', k: 1 } } }).hits.length, 6);
});

test('selection chrome keeps its on-screen size: zoom scale 2 halves it', () => {
  const d = sel({ ui: { theme: 'light', sel: { board: 'a', k: 2 }, scale: 2 } });
  const s = d.selections[0];
  assert.deepStrictEqual([s.labelH, s.fontSize, s.padX, s.padY, s.border], [12, 7, 3, 1, 1]);
  assert.strictEqual(s.labelTop, s.top - 12);
});

test('chrome_divides_by_scale_times_fit', () => {
  const pick = (ui) => { const s = sel({ ui: { theme: 'light', sel: { board: 'a', k: 2 }, ...ui } }).selections[0]; return [s.labelH, s.fontSize, s.padX, s.padY, s.border, s.top - s.labelTop]; };
  assert.deepStrictEqual(pick({ scale: 2, fit: 0.5 }), pick({ scale: 1, fit: 1 }));
  assert.deepStrictEqual(pick({ scale: 1, fit: 0.5 }), pick({ scale: 0.5 }));
  assert.deepStrictEqual(pick({ scale: 2, fit: 0 }), pick({ scale: 2 }), 'a bad fit counts as 1');
});

test('parentOf finds the parent (null at the top)', () => {
  assert.strictEqual(view.parentOf(NODES.a, 3).k, 1);
  assert.strictEqual(view.parentOf(NODES.a, 1), null);
  assert.strictEqual(view.parentOf(NODES.a, 99), null);
});
