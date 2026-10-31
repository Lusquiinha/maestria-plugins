'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const refs = require('../lib/refs');
const marks = require('../lib/marks');
const crop = require('../lib/crop');
const canvasMod = require('../lib/canvas');
const { readPng } = require('./png');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-refs-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function canvas(files) {
  const dir = path.join(tmp, `c${++n}`);
  fs.mkdirSync(path.join(dir, 'boards'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'components'), { recursive: true });
  const boards = {};
  const order = [];
  for (const [f, html] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, f), html);
    const m = /^boards\/(.+)\.html$/.exec(f);
    if (m) { boards[m[1]] = { x: 0, y: 0, w: 390 }; order.push(m[1]); }
  }
  canvasMod.write(dir, { v: 1, title: 't', boards, order });
  return { dir, data: path.join(dir + '-data') };
}

const el = (file, p, extra = {}) => ({ k: 99, kind: 'element', name: 'div', file, path: p, call: null, componentFile: null, children: [], ...extra });
const comp = (name, file, p) => ({ k: 98, kind: 'component', name, file, path: p, call: { file, path: p }, componentFile: `components/${name}.html`, children: [] });

test('the same element gets the same code across renders and reopenings; others get new ones', () => {
  const { dir, data } = canvas({ 'boards/a.html': '<main><p>oi</p><p>tchau</p></main>' });
  const r = refs.open(data, dir);
  const c1 = r.codeFor('a', el('boards/a.html', [0, 0], { k: 2 }));
  assert.match(c1, /^@n\d+$/);
  assert.strictEqual(r.codeFor('a', el('boards/a.html', [0, 0], { k: 7 })), c1, 'k changes between renders; the code does not');
  const c2 = r.codeFor('a', el('boards/a.html', [0, 1]));
  assert.notStrictEqual(c2, c1);
  assert.ok(fs.existsSync(path.join(data, 'refs.json')));
  assert.strictEqual(refs.open(data, dir).codeFor('a', el('boards/a.html', [0, 0])), c1);
});

test('three calls of a component give three codes; the same inner element in each gives three more', () => {
  const { dir, data } = canvas({
    'components/Item.html': '<li><span>{{ t }}</span></li>',
    'boards/a.html': '<ul><x-item t="a"></x-item><x-item t="b"></x-item><x-item t="c"></x-item></ul>',
  });
  const r = refs.open(data, dir);
  const calls = [0, 1, 2].map((i) => comp('Item', 'boards/a.html', [0, i]));
  const codes = calls.map((c) => r.codeFor('a', c));
  assert.strictEqual(new Set(codes).size, 3);
  // the tree: ul > call > li > span
  const roots = [{ ...el('boards/a.html', [0]), children: calls.map((c, i) => ({ ...c, k: 10 + i, children: [{ ...el('components/Item.html', [0], { k: 20 + i }), children: [el('components/Item.html', [0, 0], { k: 30 + i })] }] })) }];
  const spans = [0, 1, 2].map((i) => ({ ...el('components/Item.html', [0, 0]), via: refs.viaOf(roots, 30 + i) }));
  const spanCodes = spans.map((s) => r.codeFor('a', s));
  assert.strictEqual(new Set([...codes, ...spanCodes]).size, 6);
  const res = r.resolve(spanCodes[1], dir);
  assert.deepStrictEqual(res.call.path, [0, 1], 'the span of the second item points at the second call');
});

test('resolve gives board, file, path, snippet and, for a component, its call site and file with the boards that use it', () => {
  const { dir, data } = canvas({
    'components/NavItem.html': '<a class="px-2">{{ label }}</a>',
    'boards/a.html': '<nav>\n  <x-nav-item label="Início"></x-nav-item>\n</nav>',
    'boards/b.html': '<x-nav-item label="x" />',
    'boards/c.html': '<div></div>',
  });
  const r = refs.open(data, dir);
  const code = r.codeFor('a', comp('NavItem', 'boards/a.html', [0, 0]));
  const res = r.resolve(code, dir);
  assert.strictEqual(res.stale, undefined);
  assert.strictEqual(res.board, 'a');
  assert.strictEqual(res.file, 'boards/a.html');
  assert.deepStrictEqual(res.path, [0, 0]);
  assert.strictEqual(res.snippet, '<x-nav-item label="Início"></x-nav-item>');
  assert.strictEqual(res.line, 2);
  assert.deepStrictEqual({ file: res.call.file, path: res.call.path, snippet: res.call.snippet }, { file: 'boards/a.html', path: [0, 0], snippet: '<x-nav-item label="Início"></x-nav-item>' });
  assert.strictEqual(res.componentFile, 'components/NavItem.html');
  assert.deepStrictEqual(res.usedIn, ['a', 'b']);
  // a plain board element: no call, no component
  const p = r.resolve(r.codeFor('a', el('boards/a.html', [0])), dir);
  assert.strictEqual(p.call, null);
  assert.strictEqual(p.componentFile, undefined);
  assert.deepStrictEqual(p.usedIn, []);
});

test('stale after a sibling insert that moves the path', () => {
  const { dir, data } = canvas({ 'boards/a.html': '<main><p>um</p><p>dois</p></main><footer>f</footer>' });
  const file = path.join(dir, 'boards/a.html');
  const r = refs.open(data, dir);
  const code = r.codeFor('a', el('boards/a.html', [0, 1]));
  const foot = r.codeFor('a', el('boards/a.html', [1]));
  fs.writeFileSync(file, '<main><p>um</p><p>dois</p></main><footer>f</footer><aside></aside>');
  assert.strictEqual(r.resolve(code, dir).snippet, '<p>dois</p>', 'a later sibling does not matter');
  fs.writeFileSync(file, '<main><x-a></x-a><p>um</p><p>dois</p></main><footer>f</footer>');
  assert.deepStrictEqual(r.resolve(code, dir), { stale: true });
  fs.rmSync(file);
  assert.deepStrictEqual(r.resolve(code, dir), { stale: true });
  assert.deepStrictEqual(r.resolve(foot, dir), { stale: true });
});

test('an inner text or child edit keeps the code of the element and of its container (new snippet)', () => {
  const { dir, data } = canvas({ 'boards/a.html': '<main class="p-4"><p>um</p><p>dois</p></main>' });
  const file = path.join(dir, 'boards/a.html');
  const r = refs.open(data, dir);
  const p = r.codeFor('a', el('boards/a.html', [0, 1]));
  const main = r.codeFor('a', el('boards/a.html', [0]));
  fs.writeFileSync(file, '<main class="p-4"><p>um <b>!</b></p><p>dois, agora três</p><span>novo</span></main>');
  assert.strictEqual(r.resolve(p, dir).snippet, '<p>dois, agora três</p>');
  assert.strictEqual(r.resolve(main, dir).snippet, '<main class="p-4"><p>um <b>!</b></p><p>dois, agora três</p><span>novo</span></main>');
});

test('an attribute change on the element makes it stale; selecting again refreshes it under the same code', () => {
  const { dir, data } = canvas({ 'boards/a.html': '<main><p>um</p><p class="a">dois</p></main>' });
  const file = path.join(dir, 'boards/a.html');
  const r = refs.open(data, dir);
  const code = r.codeFor('a', el('boards/a.html', [0, 1]));
  fs.writeFileSync(file, '<main><p>um</p><p class="b">dois</p></main>');
  assert.deepStrictEqual(r.resolve(code, dir), { stale: true });
  assert.strictEqual(r.codeFor('a', el('boards/a.html', [0, 1])), code);
  assert.strictEqual(r.resolve(code, dir).snippet, '<p class="b">dois</p>');
});

test('an attribute-less sibling inserted before it makes it stale', () => {
  const { dir, data } = canvas({ 'boards/a.html': '<main><p>um</p><p>dois</p></main>' });
  const r = refs.open(data, dir);
  const code = r.codeFor('a', el('boards/a.html', [0, 1]));
  fs.writeFileSync(path.join(dir, 'boards/a.html'), '<main><h1>novo</h1><p>um</p><p>dois</p></main>');
  assert.deepStrictEqual(r.resolve(code, dir), { stale: true });
});

test('slot content of the enclosing call changing keeps the code of an element inside the component', () => {
  const { dir, data } = canvas({
    'components/Card.html': '<section><h2>{{ t }}</h2><slot></slot></section>',
    'boards/a.html': '<main><x-card t="um"><p>filho</p></x-card></main>',
  });
  const r = refs.open(data, dir);
  const h2 = r.codeFor('a', { ...el('components/Card.html', [0, 0]), via: [{ file: 'boards/a.html', path: [0, 0], componentFile: 'components/Card.html' }] });
  fs.writeFileSync(path.join(dir, 'boards/a.html'), '<main><x-card t="um"><p>outro filho</p><ul><li>x</li></ul></x-card></main>');
  const res = r.resolve(h2, dir);
  assert.strictEqual(res.snippet, '<h2>{{ t }}</h2>');
  assert.strictEqual(res.call.snippet, '<x-card t="um"><p>outro filho</p><ul><li>x</li></ul></x-card>');
  fs.writeFileSync(path.join(dir, 'boards/a.html'), '<main><x-card t="dois"><p>filho</p></x-card></main>');
  assert.deepStrictEqual(r.resolve(h2, dir), { stale: true }, 'the call itself changed');
});

test('codeFor refuses a component element without via; open needs the canvas folder', () => {
  const { dir, data } = canvas({ 'components/Card.html': '<section></section>', 'boards/a.html': '<x-card></x-card>' });
  assert.throws(() => refs.open(data, dir).codeFor('a', el('components/Card.html', [0])), /via/);
  assert.throws(() => refs.open(data), /canvasDir/);
});

test('resolve of an unknown code says so', () => {
  const { dir, data } = canvas({ 'boards/a.html': '<p></p>' });
  assert.deepStrictEqual(refs.open(data, dir).resolve('@n42', dir), { unknown: true });
});

test('locate finds the node of a code in the nodes tree (for its rect)', () => {
  const roots = [{ ...el('boards/a.html', [0], { k: 1 }), children: [
    { ...comp('Item', 'boards/a.html', [0, 0]), k: 2, rect: { x: 0, y: 0, w: 10, h: 10 }, children: [el('components/Item.html', [0], { k: 3, rect: { x: 1, y: 1, w: 5, h: 5 } })] },
    { ...comp('Item', 'boards/a.html', [0, 1]), k: 4, rect: { x: 0, y: 20, w: 10, h: 10 }, children: [el('components/Item.html', [0], { k: 5, rect: { x: 1, y: 21, w: 5, h: 5 } })] },
  ] }];
  const via = refs.viaOf(roots, 5);
  assert.deepStrictEqual(via.map((v) => v.path), [[0, 1]]);
  assert.strictEqual(refs.locate(roots, { file: 'components/Item.html', path: [0], via }).k, 5);
  assert.strictEqual(refs.locate(roots, { file: 'boards/a.html', path: [0, 0], via: [] }).k, 2);
  assert.strictEqual(refs.locate(roots, { file: 'boards/a.html', path: [9], via: [] }), null);
});

test('marks: one per tab, expire after 2 minutes, cleared by a render of the board', () => {
  marks.set('t1', { board: 'a', rect: { x: 1, y: 2, w: 3, h: 4 } }, 1000);
  marks.set('t2', { board: 'b', rect: { x: 0, y: 0, w: 1, h: 1 } }, 1000);
  assert.deepStrictEqual(marks.get('t1', 1000 + 119999).rect, { x: 1, y: 2, w: 3, h: 4 });
  assert.strictEqual(marks.get('t1', 1000 + 120001), null);
  marks.clearBoard('b');
  assert.strictEqual(marks.get('t2', 1001), null);
  assert.strictEqual(marks.get('nope', 0), null);
});

function solidPng(w, h, px) { // px(x, y) -> [r, g, b]
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = y % 5; // all five filters (data is written unfiltered for 0 only; see below)
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  // re-filter each row with its filter type so the decoder has to undo them
  const stride = w * 3;
  const out = Buffer.alloc(raw.length);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    out[y * (stride + 1)] = f;
    const row = (yy, i) => (yy < 0 || i < 0 ? 0 : raw[yy * (stride + 1) + 1 + i]);
    for (let i = 0; i < stride; i++) {
      const a = row(y, i - 3); const b = row(y - 1, i); const c = row(y - 1, i - 3);
      let pred = 0;
      if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * (stride + 1) + 1 + i] = (row(y, i) - pred) & 255;
    }
  }
  return crop.encode(w, h, 3, out, true);
}

test('crop cuts the element out of the 2x png and caps the longest side at 1568', () => {
  const src = solidPng(40, 30, (x, y) => [x, y, 7]);
  const out = crop.cropPng(src, { x: 10, y: 5, w: 8, h: 6 }, 1568);
  const p = readPng(out);
  assert.deepStrictEqual([p.width, p.height], [8, 6]);
  const raw = zlib.inflateSync(p.idat);
  assert.deepStrictEqual([...raw.subarray(1, 4)], [10, 5, 7]);
  assert.deepStrictEqual([...raw.subarray((8 * 3 + 1) * 5 + 1 + 7 * 3, (8 * 3 + 1) * 5 + 1 + 8 * 3)], [17, 10, 7]);
  const big = solidPng(4000, 4, () => [1, 2, 3]);
  const capped = readPng(crop.cropPng(big, { x: 0, y: 0, w: 4000, h: 4 }, 1568));
  assert.ok(capped.width <= 1568 && capped.width > 1000, String(capped.width));
  assert.strictEqual(crop.cropPng(src, { x: 100, y: 100, w: 5, h: 5 }, 1568), null, 'outside the image');
});

test('every source of an annotated expand resolves to the tag written there', () => {
  const components = require('../lib/components');
  const { dir, data } = canvas({
    'components/Card.html': '<section class="p-2"><h2>{{ t }}</h2><slot></slot><x-badge /></section>',
    'components/Badge.html': '<b>B</b><br>',
    'boards/a.html': '<!-- c --><main>\n<x-card t="um"><p>filho <em>x</em></p></x-card>\n<img src="a.png"><x-card t="dois" /></main>',
  });
  const exp = components.expand(fs.readFileSync(path.join(dir, 'boards/a.html'), 'utf8'), components.load(dir), { annotate: true, file: 'boards/a.html' });
  const r = refs.open(data, dir);
  assert.ok(exp.sources.size > 8);
  const viaOf = (rec) => { const v = []; for (let k = rec.inst; k != null; k = exp.sources.get(k).inst) v.unshift({ ...exp.sources.get(k) }); return v; };
  const anyInst = (file) => [...exp.sources.values()].find((x) => x.file === file && x.inst != null);
  for (const s of exp.sources.values()) {
    const owner = s.inst != null ? s : s.file.startsWith('components/') ? anyInst(s.file) : null;
    const res = r.resolve(r.codeFor('a', { ...s, via: owner ? viaOf(owner) : [] }), dir);
    assert.ok(!res.stale && !res.unknown, JSON.stringify(s));
    assert.ok(res.snippet.toLowerCase().startsWith(`<${s.tag}`), `${s.tag} ${res.snippet}`);
  }
});
