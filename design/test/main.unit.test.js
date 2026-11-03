'use strict';
// main.js in-process, with the protocol and the engine faked (no processes).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-main-unit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the protocol: requests answered by `answer`, never stdin/stdout
let answer = async () => ({ open: true });
const notified = {}; // the protocol notification handlers main.js registers
const mxPath = require.resolve('../maestria');
require.cache[mxPath] = {
  id: mxPath, filename: mxPath, loaded: true,
  exports: {
    request: (m, p) => answer(m, p),
    notify: () => {}, log: () => {}, onRequest: () => {}, onNotification: (m, fn) => { notified[m] = fn; }, start: () => {},
  },
};

const engineMod = require('../lib/engine');
const engines = [];
engineMod.open = async (dir) => {
  await sleep(30);
  const e = new EventEmitter();
  Object.assign(e, {
    dir, closed: false, chromeError: null, chrome: null, tw: null,
    canvas: { title: 't', boards: {}, order: [], warnings: [] },
    renderable: () => [],
    close: async () => { e.closed = true; },
  });
  engines.push(e);
  return e;
};

const main = require('../main');

main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
main.state.dataDir = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a view.open that fails leaves no view and closes its engine', async () => {
  const dir = path.join(tmp, 'a');
  answer = async (m) => { if (m === 'view.open') throw new Error('sem janela'); return { open: true }; };
  const before = engines.length;
  try {
    await assert.rejects(main.openCanvas(dir, {}), /sem janela/);
    assert.strictEqual(main.viewOf(dir), null);
    await sleep(100);
    assert.strictEqual(engines.length, before + 1);
    assert.strictEqual(engines[before].closed, true, 'engine closed');
  } finally {
    answer = async () => ({ open: true });
  }
});

test('reopening a canvas whose chrome gave up replaces its engine', async () => {
  const dir = path.join(tmp, 'b');
  const V = await main.openCanvas(dir, {});
  const first = V.engine;
  assert.ok(first);
  first.chromeError = 'o chrome não subiu: caiu duas vezes';
  const again = await main.openCanvas(dir, {});
  assert.strictEqual(again, V);
  assert.strictEqual(first.closed, true, 'old engine closed');
  assert.ok(V.engine && V.engine !== first, 'new engine');
  assert.strictEqual(V.engine.chromeError, null);
  // a healthy engine is reused
  const second = V.engine;
  await main.openCanvas(dir, {});
  assert.strictEqual(V.engine, second);
  await main.closeView(V.viewId);
});

test('a PreToolUse edit from the linked tab draws a scan until the board renders', async () => {
  const dir = path.join(tmp, 'c');
  const V = await main.openCanvas(dir, { tabId: 'tab-c' });
  V.canvas = { title: 't', boards: { inbox: { x: 0, y: 0, w: 400 } }, order: ['inbox'], warnings: [] };
  V.engine.uses = new Map([['inbox', new Set()]]);
  const updates = [];
  answer = async (m, p) => { if (m === 'view.update' && p.data) updates.push(p.data); return { open: true }; };
  try {
    const hook = (tabId, file) => main.onHook({ type: 'hook', name: 'PreToolUse', tabId, payload: { tool_name: 'Edit', tool_input: { file_path: file } } });
    hook('tab-other', path.join(dir, 'boards', 'inbox.html')); // not linked to this canvas
    hook('tab-c', path.join(tmp, 'elsewhere.html'));
    await sleep(10);
    assert.strictEqual(updates.length, 0);
    hook('tab-c', path.join(dir, 'boards', 'inbox.html'));
    await sleep(10);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].scans.length, 2); // light and dark
    V.engine.emit('board', 'inbox', { light: '/x.png', dark: '/y.png', width: 400, height: 100, rev: 1 });
    await sleep(10);
    assert.deepStrictEqual(updates[updates.length - 1].scans, []);
    // an edit that fails ends its scan at once
    hook('tab-c', path.join(dir, 'boards', 'inbox.html'));
    await sleep(10);
    assert.strictEqual(updates[updates.length - 1].scans.length, 2);
    const n = updates.length;
    main.onHook({ type: 'hook', name: 'PostToolUseFailure', tabId: 'tab-c', payload: { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'boards', 'inbox.html') } } });
    await sleep(10);
    assert.strictEqual(updates.length, n + 1);
    assert.deepStrictEqual(updates[updates.length - 1].scans, []);
  } finally {
    answer = async () => ({ open: true });
    await main.closeView(V.viewId);
  }
});

// --- abrir -------------------------------------------------------------

const canvasMod = require('../lib/canvas');

function homeWith(...dirs) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const out = dirs.map((rel) => {
    const d = path.join(home, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'canvas.json'), JSON.stringify({ v: 1, title: path.basename(d), boards: {}, order: [] }));
    fs.writeFileSync(path.join(d, 'design.json'), JSON.stringify({ repo: path.join(home, 'repo-of-' + path.basename(d)) }));
    return d;
  });
  main.state.home = home;
  return { home, dirs: out };
}

// a fake host: `replies[method]` is a value or (params) => value; every call is logged
function fakeHost(replies) {
  const calls = [];
  answer = async (m, p) => {
    calls.push([m, p]);
    const r = replies[m];
    if (typeof r === 'function') return r(p);
    if (r !== undefined) return r;
    return m === 'view.update' ? { open: true } : null;
  };
  return calls;
}

async function closeAllViews() {
  for (const id of [...main.state.views.keys()]) await main.closeView(id);
  answer = async () => ({ open: true });
}

test('abrir: only the canvases, most recent first, with project and folder; no "novo"', async () => {
  const { home, dirs: [x, y] } = homeWith('Desktop/Work/co/design/x', 'Desktop/Work/co/design/y');
  main.state.last = { byTab: {}, byCwd: {}, usedAt: { [x]: 1000, [y]: 2000 } };
  const calls = fakeHost({ 'window.pick': null });
  try {
    await main.abrir({});
    const picks = calls.filter(([m]) => m === 'window.pick');
    assert.strictEqual(picks.length, 1);
    const { title, items } = picks[0][1];
    assert.strictEqual(title, 'Abrir canvas de telas');
    assert.deepStrictEqual(items.map((i) => i.value), [y, x]);
    assert.deepStrictEqual(items.map((i) => i.label), ['y', 'x']);
    assert.strictEqual(items[0].detail, `repo-of-y · ${y.replace(home, '~')}`);
    assert.ok(!items.some((i) => /novo/i.test(i.label)), 'no "novo canvas…"');
    assert.ok(!calls.some(([m]) => m === 'session.openClaude' || m === 'view.open' || m === 'window.input'), 'cancel does nothing');
  } finally { await closeAllViews(); }
});

test('abrir with no canvas: a banner saying to ask Claude, no picker', async () => {
  homeWith();
  main.state.last = { byTab: {}, byCwd: {} };
  const calls = fakeHost({});
  try {
    await main.abrir({});
    assert.ok(!calls.some(([m]) => m === 'window.pick'));
    const b = calls.find(([m]) => m === 'window.showBanner');
    assert.strictEqual(b[1].text, 'Nenhum canvas ainda. Peça ao Claude numa sessão: "cria uma tela de…"');
  } finally { await closeAllViews(); }
});

test('abrir an existing canvas with no session: opens a claude in its repo and the canvas beside it', async () => {
  const { dirs: [x] } = homeWith('Desktop/Work/co/design/x');
  main.state.last = { byTab: {}, byCwd: {} };
  const calls = fakeHost({ 'window.pick': x, 'session.openClaude': { tabId: 'tab-new' }, 'sessions.list': [] });
  try {
    await main.abrir({ cwd: '/somewhere' });
    const oc = calls.find(([m]) => m === 'session.openClaude');
    assert.ok(oc, 'opened a claude session');
    assert.strictEqual(oc[1].cwd, JSON.parse(fs.readFileSync(path.join(x, 'design.json'), 'utf8')).repo);
    assert.strictEqual(oc[1].prompt, `Call design_open with canvas="${x}" and wait for my request.`);
    const order = calls.map(([m]) => m).filter((m) => ['session.openClaude', 'session.focus', 'view.open'].includes(m));
    assert.deepStrictEqual(order, ['session.openClaude', 'session.focus', 'view.open']);
    assert.strictEqual(calls.find(([m]) => m === 'session.focus')[1].tabId, 'tab-new');
    assert.strictEqual(main.state.last.byTab['tab-new'], x, 'linked to the new tab');
    assert.ok(main.state.last.usedAt[x] > 0, 'use recorded');
    assert.ok(main.viewOf(x));
  } finally { await closeAllViews(); }
});

test('abrir an existing canvas from a claude tab: opens beside it, no new session', async () => {
  const { dirs: [x] } = homeWith('Desktop/Work/co/design/x');
  main.state.last = { byTab: {}, byCwd: {} };
  const calls = fakeHost({ 'window.pick': x, 'sessions.list': [{ id: 'tab-1', kind: 'claude' }] });
  try {
    await main.abrir({ cwd: '/w', tabId: 'tab-1' });
    assert.ok(!calls.some(([m]) => m === 'session.openClaude'));
    assert.strictEqual(main.state.last.byTab['tab-1'], x);
    assert.ok(main.viewOf(x));
  } finally { await closeAllViews(); }
});

test('abrir from a tab that is not claude (a shell, the canvas itself) opens a claude', async () => {
  const { dirs: [x] } = homeWith('Desktop/Work/co/design/x');
  main.state.last = { byTab: {}, byCwd: {} };
  const calls = fakeHost({ 'window.pick': x, 'sessions.list': [{ id: 'tab-1', kind: 'plugin' }], 'session.openClaude': { tabId: 'tab-2' } });
  try {
    await main.abrir({ cwd: '/w', tabId: 'tab-1' });
    assert.ok(calls.some(([m]) => m === 'session.openClaude'));
    assert.strictEqual(main.state.last.byTab['tab-2'], x);
  } finally { await closeAllViews(); }
});

test('abrir reuses the live claude tab already linked to the canvas (most recent link first)', async () => {
  const { dirs: [x] } = homeWith('Desktop/Work/co/design/x');
  main.state.last = { byTab: { 'tab-old': x, 'tab-other': '/elsewhere', 'tab-new': x }, byCwd: {} };
  const calls = fakeHost({
    'window.pick': x,
    'sessions.list': [{ id: 'tab-old', kind: 'claude' }, { id: 'tab-new', kind: 'claude', hibernated: true }, { id: 'tab-sh', kind: 'shell' }],
  });
  try {
    await main.abrir({ cwd: '/w', tabId: 'tab-sh' });
    assert.ok(!calls.some(([m]) => m === 'session.openClaude'), 'no new session');
    assert.strictEqual(calls.find(([m]) => m === 'session.focus')[1].tabId, 'tab-new');
    assert.ok(main.viewOf(x));
  } finally { await closeAllViews(); }
});

test('abrir: a linked tab that has exited is not reused', async () => {
  const { dirs: [x] } = homeWith('Desktop/Work/co/design/x');
  main.state.last = { byTab: { 'tab-dead': x }, byCwd: {} };
  const calls = fakeHost({ 'window.pick': x, 'sessions.list': [{ id: 'tab-dead', kind: 'claude', exited: true }], 'session.openClaude': { tabId: 'tab-z' } });
  try {
    await main.abrir({});
    assert.ok(calls.some(([m]) => m === 'session.openClaude'));
    assert.strictEqual(main.state.last.byTab['tab-z'], x);
  } finally { await closeAllViews(); }
});

// --- the Design tab in the sidebar ----------------------------------------------------

const sidebarUpdates = (calls) => calls.filter(([m]) => m === 'sidebar.update').map(([, p]) => p);

test('sidebar.shown: the tab gets its library once and the canvases, most recent first', async () => {
  const { dirs: [x, y] } = homeWith('Desktop/Work/co/design/x', 'Desktop/Work/co/design/y');
  main.state.last = { byTab: {}, byCwd: {}, usedAt: { [x]: 1000, [y]: 2000 } };
  const calls = fakeHost({ 'sidebar.update': { shown: true } });
  try {
    await notified.event({ type: 'sidebar.shown' });
    await notified.event({ type: 'sidebar.shown' });
    const ups = sidebarUpdates(calls);
    assert.strictEqual(ups.length, 2);
    assert.strictEqual(ups[0].rfw.root, 'root');
    assert.match(ups[0].rfw.library, /widget root/);
    assert.ok(!('rfw' in ups[1]), 'the library is sent once');
    const d = ups[1].data;
    assert.strictEqual(d.text, 'Para criar um design novo, peça ao Claude numa sessão: "cria uma tela de…"');
    assert.deepStrictEqual(d.canvases.map((c) => [c.name, c.project, c.open]), [['y', 'repo-of-y', `open:${y}`], ['x', 'repo-of-x', `open:${x}`]]);
  } finally {
    await notified.event({ type: 'sidebar.hidden' });
    await closeAllViews();
  }
});

test('the sidebar follows the canvas list while shown, and stays quiet when hidden', async () => {
  const { dirs: [x, y] } = homeWith('Desktop/Work/co/design/x', 'Desktop/Work/co/design/y');
  main.state.last = { byTab: {}, byCwd: {}, usedAt: { [x]: 1000, [y]: 2000 } };
  const calls = fakeHost({ 'sidebar.update': { shown: true } });
  try {
    await notified.event({ type: 'sidebar.shown' });
    await main.openCanvas(x, {});
    await sleep(10);
    const last = sidebarUpdates(calls).pop();
    assert.deepStrictEqual(last.data.canvases.map((c) => c.name), ['x', 'y'], 'the opened canvas moves to the top');
    await notified.event({ type: 'sidebar.hidden' });
    const n = sidebarUpdates(calls).length;
    await main.openCanvas(y, {});
    await sleep(10);
    assert.strictEqual(sidebarUpdates(calls).length, n);
  } finally { await closeAllViews(); }
});

test('a click on a canvas in the sidebar opens it beside the focused claude', async () => {
  const { dirs: [x] } = homeWith('Desktop/Work/co/design/x');
  main.state.last = { byTab: {}, byCwd: {} };
  const calls = fakeHost({
    'sessions.focused': { id: 'tab-f', kind: 'claude', cwd: '/w' },
    'sessions.list': [{ id: 'tab-f', kind: 'claude' }],
    'sidebar.update': { shown: false },
  });
  try {
    await notified['view.action']({ viewId: 'sidebar', action: 'act', values: { a: `open:${x}` } });
    assert.ok(!calls.some(([m]) => m === 'session.openClaude'));
    assert.strictEqual(calls.find(([m]) => m === 'session.focus')[1].tabId, 'tab-f');
    assert.strictEqual(main.state.last.byTab['tab-f'], x);
    assert.ok(main.viewOf(x));
  } finally { await closeAllViews(); }
});

test('a click on a canvas in the sidebar with no claude focused opens one in its repo', async () => {
  const { dirs: [x] } = homeWith('Desktop/Work/co/design/x');
  main.state.last = { byTab: {}, byCwd: {} };
  const calls = fakeHost({ 'sessions.focused': null, 'sessions.list': [], 'session.openClaude': { tabId: 'tab-o' }, 'sidebar.update': { shown: false } });
  try {
    await notified['view.action']({ viewId: 'sidebar', action: 'act', values: { a: `open:${x}` } });
    assert.ok(calls.some(([m]) => m === 'session.openClaude'));
    assert.ok(main.viewOf(x));
    await notified['view.action']({ viewId: 'sidebar', action: 'act', values: { a: 'open:/not/a/canvas' } });
    assert.ok(!main.viewOf('/not/a/canvas'), 'only listed canvases open');
  } finally { await closeAllViews(); }
});

test('the canvas tab is titled "Design · <canvas title>"', async () => {
  const dir = path.join(tmp, 'titled');
  const calls = fakeHost({});
  try {
    await main.openCanvas(dir, {});
    const opens = calls.filter(([m]) => m === 'view.open').map(([, p]) => p.title);
    assert.deepStrictEqual(opens, ['Design · titled']);
    await sleep(60);
    const ups = calls.filter(([m, p]) => m === 'view.update' && p.title).map(([, p]) => p.title);
    assert.strictEqual(ups.pop(), 'Design · t', 'the engine canvas title');
  } finally { await closeAllViews(); }
});

// ---- selection --------------------------------------------------------------

async function selCanvas(name) {
  main.state.caps = { rfw: true, picture: 1, zoomFocus: 1, zoomPan: 1, keyListener: 1 };
  const dir = path.join(tmp, name);
  const V = await main.openCanvas(dir, {});
  const nd = (k, children = []) => ({ k, rect: { x: k, y: k, w: 50, h: 20 }, kind: 'element', name: `n${k}`, file: 'boards/x.html', path: [k], call: null, componentFile: null, children });
  const nodesDir = path.join(tmp, main.hashOf(dir), 'nodes');
  fs.mkdirSync(nodesDir, { recursive: true });
  fs.writeFileSync(path.join(nodesDir, 'x.json'), JSON.stringify({ roots: [nd(1, [nd(3), nd(4)]), nd(2)] }));
  V.canvas = { title: 't', boards: { x: { x: 0, y: 0, w: 400, h: 200 } }, order: ['x'], warnings: [] };
  V.states.set('x', { light: 'l.png', dark: 'd.png', width: 400, height: 200, rev: 1 });
  return V;
}
const lastData = (calls) => calls.filter((c) => c.m === 'view.update' && c.p.data).pop().p.data;

test('a double click on a child of the selected node picks it and opens its level', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return { open: true }; };
  const V = await selCanvas('sel-child');
  try {
    await main.onAction(V, 'sel:x:1');
    let d = lastData(calls);
    assert.deepStrictEqual(d.hits.filter((h) => h.dbl.startsWith('child:')).map((h) => [h.k, h.tap]), [[3, 'sel:x:1'], [3, 'sel:x:1'], [4, 'sel:x:1'], [4, 'sel:x:1']]);
    await main.onAction(V, 'child:x:3');
    assert.deepStrictEqual(V.ui.sel, { board: 'x', k: 3 });
    assert.deepStrictEqual(V.ui.level, { board: 'x', k: 1 });
    d = lastData(calls);
    assert.strictEqual(d.selection.label, 'n3');
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('a tap that ends a pan does not select (move before or just after it)', async () => {
  answer = async () => ({ open: true });
  const V = await selCanvas('sel-pan');
  try {
    // onMove arrived first (the user held still before releasing)
    await main.onAction(V, 'move', { scale: 1, x: 0, y: 0 });
    await main.onAction(V, 'sel:x:1');
    assert.strictEqual(V.ui.sel, null, 'dropped right after a move');
    await sleep(260);
    await main.onAction(V, 'sel:x:1');
    assert.deepStrictEqual(V.ui.sel, { board: 'x', k: 1 }, 'a later tap selects');
    // the click came first and onMove right after: the click is undone
    await sleep(260);
    await main.onAction(V, 'sel:x:2');
    assert.strictEqual(V.ui.sel.k, 2);
    await main.onAction(V, 'move', { scale: 1, x: 5, y: 5 });
    assert.deepStrictEqual(V.ui.sel, { board: 'x', k: 1 }, 'back to before the pan');
    // a clear that ended a pan is undone too
    await sleep(260);
    await main.onAction(V, 'clear');
    await main.onAction(V, 'move', { scale: 1, x: 6, y: 6 });
    assert.deepStrictEqual(V.ui.sel, { board: 'x', k: 1 });
    // zoom keys do not block taps (only onMove does)
    await sleep(260);
    await main.onAction(V, 'key', { key: 'ctrl+=' });
    await main.onAction(V, 'sel:x:2');
    assert.strictEqual(V.ui.sel.k, 2);
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('the zoom scale from onZoom/onMove shrinks the selection chrome', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return { open: true }; };
  const V = await selCanvas('sel-scale');
  try {
    await main.onAction(V, 'sel:x:2');
    assert.ok(Math.abs(lastData(calls).selection.border - 2) < 1e-6);
    await main.onAction(V, 'zoom', { scale: 2 });
    assert.strictEqual(V.ui.scale, 2);
    const s = lastData(calls).selection;
    assert.ok(Math.abs(s.border - 1) < 1e-6 && Math.abs(s.labelH - 12) < 1e-6 && Math.abs(s.fontSize - 7) < 1e-6);
    await sleep(260);
    await main.onAction(V, 'move', { scale: 4, x: 0, y: 0 });
    assert.ok(Math.abs(lastData(calls).selection.border - 0.5) < 1e-6);
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('fit from onZoom/onMove divides the chrome too (absent: 1)', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return { open: true }; };
  const V = await selCanvas('sel-fit');
  try {
    await main.onAction(V, 'sel:x:2');
    await main.onAction(V, 'zoom', { scale: 2, fit: 0.5 });
    assert.strictEqual(V.ui.fit, 0.5);
    assert.ok(Math.abs(lastData(calls).selection.border - 2) < 1e-6, 'scale 2 x fit 0.5 = 1');
    const n = calls.length;
    await main.onAction(V, 'zoom', { scale: 2, fit: 0.5 });
    assert.strictEqual(calls.filter((c) => c.m === 'view.update').length, calls.slice(0, n).filter((c) => c.m === 'view.update').length, 'nothing changed: no redraw');
    await main.onAction(V, 'zoom', { scale: 2, fit: 0.25 });
    assert.ok(Math.abs(lastData(calls).selection.border - 4) < 1e-6, 'fit alone re-renders');
    await sleep(260);
    await main.onAction(V, 'move', { scale: 2, fit: 1, x: 0, y: 0 });
    assert.ok(Math.abs(lastData(calls).selection.border - 1) < 1e-6);
    await sleep(260);
    await main.onAction(V, 'zoom', { scale: 4 });
    assert.strictEqual(V.ui.fit, 1, 'an old app sends no fit');
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('ctrl+c after the source changed but before the new render shows the message and copies nothing', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return { open: true }; };
  const V = await selCanvas('sel-stale');
  try {
    fs.mkdirSync(path.join(V.dir, 'boards'), { recursive: true });
    const src = path.join(V.dir, 'boards', 'x.html');
    fs.writeFileSync(src, '<p>1</p><p>2</p>');
    const nodesFile = path.join(tmp, main.hashOf(V.dir), 'nodes', 'x.json');
    fs.utimesSync(nodesFile, 1000, 1000);
    fs.utimesSync(src, 2000, 2000);
    await main.onAction(V, 'sel:x:1');
    await main.onAction(V, 'key', { key: 'ctrl+c' });
    assert.ok(!calls.some((c) => c.m === 'clipboard.write'), 'nothing copied');
    assert.ok(calls.some((c) => c.m === 'window.showBanner' && c.p.text === 'A tela mudou: espere a imagem nova'));
    fs.utimesSync(nodesFile, 3000, 3000);
    await main.onAction(V, 'key', { key: 'ctrl+c' });
    assert.match(calls.find((c) => c.m === 'clipboard.write').p.text, /^@n\d+$/);
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('right-click copy on a node that is not the selection selects it and copies its code; a stale source is refused', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return { open: true }; };
  const V = await selCanvas('sel-menu');
  try {
    await main.onAction(V, 'sel:x:1');
    await main.onAction(V, 'copy:x:2');
    assert.deepStrictEqual(V.ui.sel, { board: 'x', k: 2 });
    const clip = calls.filter((c) => c.m === 'clipboard.write');
    assert.strictEqual(clip.length, 1);
    assert.match(clip[0].p.text, /^@n\d+$/);
    await main.onAction(V, 'copy:x:1');
    const first = calls.filter((c) => c.m === 'clipboard.write')[1].p.text;
    assert.notStrictEqual(first, clip[0].p.text);
    const n = calls.length;
    await main.onAction(V, 'copy:x:99');
    assert.strictEqual(calls.length, n);
    fs.mkdirSync(path.join(V.dir, 'boards'), { recursive: true });
    const src = path.join(V.dir, 'boards', 'x.html');
    fs.writeFileSync(src, '<p>1</p><p>2</p>');
    const nodesFile = path.join(tmp, main.hashOf(V.dir), 'nodes', 'x.json');
    fs.utimesSync(nodesFile, 1000, 1000);
    fs.utimesSync(src, 2000, 2000);
    await main.onAction(V, 'copy:x:2');
    assert.strictEqual(calls.filter((c) => c.m === 'clipboard.write').length, 2, 'stale: nothing copied');
    assert.ok(calls.some((c) => c.m === 'window.showBanner' && c.p.text === 'A tela mudou: espere a imagem nova'));
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('rename: the label asks for a name (current title as value) and writes only the title', async () => {
  const calls = [];
  let reply = 'Notificações 2';
  answer = async (m, p) => { calls.push({ m, p }); return m === 'window.input' ? reply : { open: true }; };
  const V = await selCanvas('rename');
  try {
    const canvasMod = require('../lib/canvas');
    fs.mkdirSync(path.join(V.dir, 'boards'), { recursive: true });
    fs.writeFileSync(path.join(V.dir, 'boards', 'notificacoes.html'), '<p>x</p>');
    canvasMod.write(V.dir, { v: 1, title: 't', boards: { notificacoes: { x: 0, y: 0, w: 400, title: 'Notificações' } }, order: ['notificacoes'] });
    const title = () => canvasMod.read(V.dir).boards.notificacoes.title;
    await main.onAction(V, 'rename:notificacoes');
    const inp = calls.find((c) => c.m === 'window.input');
    assert.strictEqual(inp.p.value, 'Notificações');
    assert.strictEqual(inp.p.prompt, undefined);
    assert.strictEqual(inp.p.title, 'Renomear tela');
    assert.strictEqual(inp.p.placeholder, 'Nome da tela');
    assert.strictEqual(title(), 'Notificações 2');
    assert.deepStrictEqual(Object.keys(canvasMod.read(V.dir).boards), ['notificacoes']);
    assert.ok(fs.existsSync(path.join(V.dir, 'boards', 'notificacoes.html')));
    for (reply of ['', '   ', null]) {
      await main.onAction(V, 'rename:notificacoes');
      assert.strictEqual(title(), 'Notificações 2', `no write for ${JSON.stringify(reply)}`);
    }
    reply = '  Avisos  ';
    await main.onAction(V, 'rename:notificacoes');
    assert.strictEqual(title(), 'Avisos');
    reply = 'x'.repeat(121);
    await main.onAction(V, 'rename:notificacoes');
    assert.strictEqual(title(), 'Avisos', 'over 120 chars: no write');
    assert.ok(calls.some((c) => c.m === 'window.showBanner' && c.p.text === 'O nome da tela passa de 120 caracteres'));
    // a concurrent edit while the dialog is open survives
    answer = async (m) => {
      if (m !== 'window.input') return { open: true };
      const c = canvasMod.read(V.dir);
      canvasMod.write(V.dir, { ...c, boards: { ...c.boards, outra: { x: 5, y: 6, w: 300 } } });
      return 'Novo';
    };
    await main.onAction(V, 'rename:notificacoes');
    const after = canvasMod.read(V.dir);
    assert.strictEqual(after.boards.notificacoes.title, 'Novo');
    assert.deepStrictEqual(after.boards.outra, { x: 5, y: 6, w: 300 });
    await main.onAction(V, 'rename:nope'); // unknown board: nothing
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

// ---- comments ---------------------------------------------------------------

const commentsMod = require('../lib/comments');

// selCanvas with a real source for node 1 (path [1] = the second <p>), the node map newer than it
function withSource(V) {
  fs.mkdirSync(path.join(V.dir, 'boards'), { recursive: true });
  const src = path.join(V.dir, 'boards', 'x.html');
  fs.writeFileSync(src, '<p>0</p><p>1</p><p>2</p>');
  fs.utimesSync(src, 1000, 1000);
  fs.utimesSync(path.join(tmp, main.hashOf(V.dir), 'nodes', 'x.json'), 2000, 2000);
  return src;
}

test('comment: right-click "Comentar…" selects the node, asks for the text and stores it with code and rect', async () => {
  const calls = [];
  let reply = '  mais escuro  ';
  answer = async (m, p) => { calls.push({ m, p }); return m === 'window.input' ? reply : { open: true }; };
  const V = await selCanvas('comment');
  try {
    withSource(V);
    await main.onAction(V, 'comment:x:1');
    assert.deepStrictEqual(V.ui.sel, { board: 'x', k: 1 });
    const inp = calls.find((c) => c.m === 'window.input');
    assert.deepStrictEqual([inp.p.title, inp.p.placeholder], ['Comentar', 'Escreva o comentário']);
    const [c] = commentsMod.open(V.dir).list();
    assert.strictEqual(c.board, 'x');
    assert.match(c.code, /^@n\d+$/);
    assert.strictEqual(c.text, 'mais escuro');
    assert.deepStrictEqual(c.rect, { x: 1, y: 1, w: 50, h: 20 });
    const d = lastData(calls);
    assert.strictEqual(d.pins.length, 2, 'light and dark');
    assert.strictEqual(d.pins[0].label, String(c.id));
    for (reply of ['', '   ', null]) {
      await main.onAction(V, 'comment:x:1');
      assert.strictEqual(commentsMod.open(V.dir).list().length, 1, `no comment for ${JSON.stringify(reply)}`);
    }
    await main.onAction(V, 'comment:x:99'); // no such node
    assert.strictEqual(commentsMod.open(V.dir).list().length, 1);
  } finally {
    answer = async () => ({ open: true });
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('comment on a node whose source changed before the new render: the message, no dialog, no comment', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return m === 'window.input' ? 'x' : { open: true }; };
  const V = await selCanvas('comment-stale');
  try {
    const src = withSource(V);
    fs.utimesSync(src, 3000, 3000);
    await main.onAction(V, 'comment:x:1');
    assert.ok(!calls.some((c) => c.m === 'window.input'));
    assert.ok(calls.some((c) => c.m === 'window.showBanner' && c.p.text === 'A tela mudou: espere a imagem nova'));
    assert.deepStrictEqual(commentsMod.open(V.dir).list(), []);
  } finally {
    answer = async () => ({ open: true });
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('pin menu: reply, edit (current text as value) and delete call the store; empty or cancel do nothing', async () => {
  const calls = [];
  let reply = null;
  answer = async (m, p) => { calls.push({ m, p }); return m === 'window.input' ? reply : { open: true }; };
  const V = await selCanvas('pin-menu');
  try {
    fs.mkdirSync(V.dir, { recursive: true });
    const C = commentsMod.open(V.dir);
    const id = C.add({ board: 'x', code: '@n1', text: 'azul', rect: { x: 0, y: 0, w: 10, h: 10 } });
    const get = () => C.list().find((c) => c.id === id);
    for (reply of ['', '  ', null]) {
      await main.onAction(V, `reply:${id}`);
      await main.onAction(V, `edit:${id}`);
    }
    assert.deepStrictEqual([get().text, get().replies], ['azul', []]);
    const inputs = calls.filter((c) => c.m === 'window.input').map((c) => c.p);
    assert.deepStrictEqual([inputs[0].title, inputs[0].placeholder], ['Responder', 'Escreva o comentário']);
    assert.deepStrictEqual([inputs[1].title, inputs[1].placeholder, inputs[1].value], ['Editar comentário', 'Escreva o comentário', 'azul']);
    C.reply(id, { author: 'claude', text: 'pronto', done: true });
    reply = ' não ficou bom ';
    await main.onAction(V, `reply:${id}`);
    assert.deepStrictEqual(get().replies.map((r) => [r.author, r.text]), [['claude', 'pronto'], ['user', 'não ficou bom']]);
    assert.strictEqual(get().status, 'aberto', 'an answer from the user reopens it');
    reply = 'verde';
    await main.onAction(V, `edit:${id}`);
    assert.strictEqual(get().text, 'verde');
    assert.match(lastData(calls).pins[0].tooltip, /^#\d+ · verde\nClaude: pronto\nVocê: não ficou bom$/);
    await main.onAction(V, `delete:${id}`);
    assert.deepStrictEqual(C.list(), []);
    assert.deepStrictEqual(lastData(calls).pins, []);
    const n = calls.filter((c) => c.m === 'window.input').length;
    await main.onAction(V, `delete:${id}`); // gone: a message, nothing else
    await main.onAction(V, `reply:${id}`);
    assert.strictEqual(calls.filter((c) => c.m === 'window.input').length, n);
    assert.ok(calls.some((c) => c.m === 'window.showBanner' && c.p.text === `Comentário ${id} não existe`));
  } finally {
    answer = async () => ({ open: true });
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('pins follow the element while its code resolves and stay at the last known rect once stale', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return m === 'window.input' ? 'oi' : { open: true }; };
  const V = await selCanvas('pin-rect');
  try {
    const src = withSource(V);
    await main.onAction(V, 'comment:x:1');
    const nodesFile = path.join(tmp, main.hashOf(V.dir), 'nodes', 'x.json');
    const moved = (x) => ({ k: 1, rect: { x, y: 1, w: 50, h: 20 }, kind: 'element', name: 'n1', file: 'boards/x.html', path: [1], call: null, componentFile: null, children: [] });
    fs.writeFileSync(nodesFile, JSON.stringify({ roots: [moved(100)] }));
    V.nodes.delete('x');
    await main.render(V);
    const pinLeft = () => lastData(calls).pins[0].left;
    const left100 = pinLeft();
    assert.deepStrictEqual(commentsMod.open(V.dir).list()[0].rect, { x: 100, y: 1, w: 50, h: 20 }, 'the last known rect is kept');
    fs.writeFileSync(src, '<b></b><p>0</p><p>1</p><p>2</p>'); // stale now
    fs.writeFileSync(nodesFile, JSON.stringify({ roots: [moved(300)] }));
    V.nodes.delete('x');
    await main.render(V);
    assert.strictEqual(pinLeft(), left100);
  } finally {
    answer = async () => ({ open: true });
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('zoom redraws when pins are on screen (they keep their size)', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return { open: true }; };
  const V = await selCanvas('pin-zoom');
  try {
    fs.mkdirSync(V.dir, { recursive: true });
    commentsMod.open(V.dir).add({ board: 'x', code: '@n1', text: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } });
    await main.render(V);
    await main.onAction(V, 'zoom', { scale: 2 });
    assert.ok(Math.abs(lastData(calls).pins[0].size - 12) < 1e-6, `pin size ${lastData(calls).pins[0].size}`);
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});

test('a corrupt comments.json draws no pins and does not break the canvas', async () => {
  const calls = [];
  answer = async (m, p) => { calls.push({ m, p }); return { open: true }; };
  const V = await selCanvas('pin-corrupt');
  try {
    fs.mkdirSync(V.dir, { recursive: true });
    fs.writeFileSync(path.join(V.dir, 'comments.json'), '{');
    await main.render(V);
    const d = lastData(calls);
    assert.deepStrictEqual(d.pins, []);
    assert.strictEqual(d.boards.length, 1);
  } finally {
    await main.closeView(V.viewId);
    main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
  }
});
