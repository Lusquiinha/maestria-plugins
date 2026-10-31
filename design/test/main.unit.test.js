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
const mxPath = require.resolve('../maestria');
require.cache[mxPath] = {
  id: mxPath, filename: mxPath, loaded: true,
  exports: {
    request: (m, p) => answer(m, p),
    notify: () => {}, log: () => {}, onRequest: () => {}, onNotification: () => {}, start: () => {},
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
  } finally {
    answer = async () => ({ open: true });
    await main.closeView(V.viewId);
  }
});
