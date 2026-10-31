'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chromeMod = require('../lib/chrome');
const components = require('../lib/components');
const nodes = require('../lib/nodes');
const { renderPage } = require('../lib/render');

const el = (k, path, name = 'div', extra = {}) => [k, { file: 'boards/b.html', path, kind: 'element', name, ...extra }];
const box = (k, p, x, y, w, h, text = false) => ({ k, p, x, y, w, h, text });

test('tree nests by parent, keeps sources and skips same-rect wrappers', () => {
  const sources = new Map([
    el(1, [0]), el(2, [0, 0]), el(3, [0, 0, 0], 'p'), el(4, [0, 0, 1], 'span'),
    [5, { file: 'components/Card.html', path: [0], kind: 'component', name: 'Card', call: { file: 'boards/b.html', path: [0, 1] } }],
  ]);
  const boxes = [
    box(1, null, 0, 0, 400, 300),
    box(2, 1, 0, 0, 400, 300), // anonymous wrapper, same rect as its parent: skipped
    box(3, 2, 10, 10, 100, 20, true),
    box(4, 2, 0, 0, 400, 300, true), // same rect but holds text: kept
    box(5, 1, 0, 0, 400, 300), // component instance with the parent's rect: kept
  ];
  const { roots } = nodes.tree(boxes, sources);
  assert.strictEqual(roots.length, 1);
  const r = roots[0];
  assert.deepStrictEqual({ ...r, children: undefined }, {
    k: 1, rect: { x: 0, y: 0, w: 400, h: 300 }, kind: 'element', name: 'div', file: 'boards/b.html', path: [0], call: null, component: null, children: undefined,
  });
  assert.deepStrictEqual(r.children.map((c) => c.k), [3, 4, 5]);
  assert.deepStrictEqual(r.children[2].call, { file: 'boards/b.html', path: [0, 1] });
  assert.strictEqual(r.children[2].kind, 'component');
  assert.strictEqual(r.children[2].name, 'Card');
});

const count = (ns) => ns.reduce((n, x) => n + 1 + count(x.children), 0);
const depth = (ns) => ns.reduce((d, x) => Math.max(d, 1 + depth(x.children)), 0);

test('tree caps at 2000 nodes, keeping the shallow ones', () => {
  const sources = new Map();
  const boxes = [box(1, null, 0, 0, 1000, 5000)];
  sources.set(1, el(1, [0])[1]);
  for (let i = 0; i < 3000; i++) {
    const k = 2 + i;
    boxes.push(box(k, 1, 0, i, 10, 1));
    sources.set(k, el(k, [0, i])[1]);
  }
  const { roots } = nodes.tree(boxes, sources);
  assert.strictEqual(count(roots), 2000);
  assert.strictEqual(nodes.MAX_NODES, 2000);
});

test('tree caps depth at 12', () => {
  const sources = new Map();
  const boxes = [];
  for (let i = 1; i <= 30; i++) {
    boxes.push(box(i, i === 1 ? null : i - 1, i, i, 500 - i * 2, 500 - i * 2));
    sources.set(i, el(i, Array(i).fill(0))[1]);
  }
  const { roots } = nodes.tree(boxes, sources);
  assert.strictEqual(depth(roots), 12);
  assert.strictEqual(nodes.MAX_DEPTH, 12);
});

test('tree drops boxes with no source (raw-param html) and hoists their children', () => {
  const sources = new Map([el(1, [0]), el(3, [0, 0, 0], 'b')]);
  const { roots } = nodes.tree([box(1, null, 0, 0, 100, 100), box(2, 1, 0, 0, 50, 50), box(3, 2, 0, 0, 10, 10, true)], sources);
  assert.deepStrictEqual(roots[0].children.map((c) => c.k), [3]);
});

const exe = chromeMod.findExecutable();
test('collectScript returns visible boxes with parent ids and text flags (chrome)', { skip: !exe && 'no chrome' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-nodes-'));
  const chrome = await chromeMod.launch({ log: () => {} });
  try {
    const exp = components.expand(
      '<div style="width:200px;height:100px;padding:10px"><p style="margin:0">oi</p><span style="display:none">x</span>'
      + '<div style="visibility:hidden;height:5px"></div><i></i><svg width="20" height="20"><rect width="5" height="5"/></svg></div>',
      new Map(), { annotate: true, file: 'boards/b.html' });
    const file = path.join(tmp, 'p.html');
    fs.writeFileSync(file, `<!doctype html><html><body style="margin:0">${exp.html}</body></html>`);
    const r = await renderPage(chrome, { htmlPath: file, width: 300, dark: null, out: path.join(tmp, 'p.png'), collect: nodes.collectScript });
    const boxes = r.collected;
    const byName = (n) => boxes.filter((b) => exp.sources.get(b.k).name === n);
    assert.deepStrictEqual(boxes.map((b) => exp.sources.get(b.k).name), ['div', 'p', 'svg']);
    const [div] = byName('div');
    assert.deepStrictEqual([div.x, div.y, div.w, div.h, div.p, div.text], [0, 0, 220, 120, null, false]);
    const [p] = byName('p');
    assert.strictEqual(p.p, div.k);
    assert.strictEqual(p.text, true);
    assert.deepStrictEqual([p.x, p.y], [10, 10]);
  } finally {
    await chrome.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
