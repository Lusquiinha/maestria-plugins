'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const components = require('../lib/components');

const comps = (o) => new Map(Object.entries(o));

test('expands params, closing tag form', () => {
  const c = comps({ NavItem: '<a class="{{active}}">{{label}}</a>' });
  const r = components.expand('<x-nav-item label="Conversas" active="true"></x-nav-item>', c);
  assert.strictEqual(r.html, '<a class="true">Conversas</a>');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual([...r.uses], ['NavItem']);
});

test('self-closing, single quotes, boolean attr, missing param', () => {
  const c = comps({ NavItem: '<a class="{{active}}">{{label}}|{{none}}</a>' });
  assert.strictEqual(components.expand("<x-nav-item label='A' active />", c).html, '<a class="true">A|</a>');
  assert.strictEqual(components.expand('<x-nav-item label="B"/>', c).html, '<a class="">B|</a>');
});

test('escapes params, raw with triple braces', () => {
  const c = comps({ T: '<i>{{v}}</i><u>{{{v}}}</u>' });
  const r = components.expand('<x-t v="<b>"></x-t>', c);
  assert.strictEqual(r.html, '<i>&lt;b&gt;</i><u><b></u>');
});

test('slot receives children', () => {
  const c = comps({ Card: '<div class="card"><slot></slot></div>' });
  const r = components.expand('<x-card><p>oi</p></x-card>', c);
  assert.strictEqual(r.html, '<div class="card"><p>oi</p></div>');
});

test('nested usage reports uses and leaves no x- tags', () => {
  const c = comps({
    Sidebar: '<nav><slot></slot><x-nav-item label="Fixo"></x-nav-item></nav>',
    NavItem: '<a>{{label}}</a>',
  });
  const r = components.expand('<x-sidebar><x-nav-item label="A"/></x-sidebar>', c);
  assert.strictEqual(r.html, '<nav><a>A</a><a>Fixo</a></nav>');
  assert.deepStrictEqual(r.uses, new Set(['Sidebar', 'NavItem']));
  assert.ok(!/<\/?x-/.test(r.html));
});

test('same component nested inside itself in children', () => {
  const c = comps({ Box: '<div><slot></slot></div>' });
  const r = components.expand('<x-box>a<x-box>b</x-box>c</x-box>', c);
  assert.strictEqual(r.html, '<div>a<div>b</div>c</div>');
});

test('unknown component errors', () => {
  const r = components.expand('<x-foo>k</x-foo>', comps({}));
  assert.deepStrictEqual(r.errors, ['componente não existe: Foo']);
  assert.ok(!/<\/?x-/.test(r.html));
});

test('cycle detected', () => {
  const c = comps({ A: '<x-b></x-b>', B: '<x-a></x-a>' });
  const r = components.expand('<x-a></x-a>', c);
  assert.ok(r.errors.includes('componente em ciclo: A → B → A'), r.errors.join('|'));
  assert.ok(!/<\/?x-/.test(r.html));
});

test('dependents', () => {
  const boards = new Map([
    ['b1', new Set(['Sidebar', 'NavItem'])],
    ['b2', new Set(['Card'])],
  ]);
  assert.deepStrictEqual(components.dependents(boards, 'NavItem'), new Set(['b1']));
  assert.deepStrictEqual(components.dependents(boards, 'X'), new Set());
});

test('load reads valid names, reports invalid', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-'));
  try {
    fs.mkdirSync(path.join(d, 'components'));
    fs.writeFileSync(path.join(d, 'components', 'Card.html'), '<b/>');
    fs.writeFileSync(path.join(d, 'components', 'bad name.html'), 'x');
    fs.writeFileSync(path.join(d, 'components', 'nota.txt'), 'x');
    const m = components.load(d);
    assert.deepStrictEqual([...m.keys()], ['Card']);
    assert.strictEqual(m.errors.length, 1);
    assert.deepStrictEqual([...components.load(path.join(d, 'nope')).keys()], []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

const malformed = (name, input, re) => test('malformed: ' + name, () => {
  const c = comps({ Card: '<div><slot></slot></div>' });
  const r = components.expand(input, c);
  assert.ok(r.errors.some((e) => re.test(e)), r.errors.join('|'));
  assert.ok(!/<x-|<\/x-/.test(r.html), r.html);
});
malformed('unclosed', '<x-card>abc', /não fechada/);
malformed('stray close', 'a</x-card>b', /sem abertura/);
malformed('unterminated quote', '<x-card class="oops>x', /inválida/);
malformed('unterminated open', '<x-card', /inválida/);
malformed('bare', 'a<x-b', /inválida/);
malformed('bare dash gt', 'a<x->b', /inválida/);
test('unclosed keeps children', () => {
  const r = components.expand('<x-card>abc', comps({ Card: '<div><slot></slot></div>' }));
  assert.strictEqual(r.html, '<div>abc</div>');
});

// ---- annotate (node ids for selection) ------------------------------------
const dnOf = (html) => [...html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*?\sdata-dn="(\d+)"/gi)].map((m) => [m[1], Number(m[2])]);
const openTags = (html) => [...html.matchAll(/<[a-z][a-z0-9-]*\b[^>]*>/gi)].map((m) => m[0]);

test('annotate puts a unique data-dn on every element and maps board elements to their path', () => {
  const r = components.expand('<div class="a"><p>oi <b>x</b></p><img src="i.png"><br/><span>z</span></div>', comps({}),
    { annotate: true, file: 'boards/x.html' });
  assert.deepStrictEqual(r.errors, []);
  const tags = openTags(r.html);
  assert.strictEqual(tags.length, 6);
  for (const t of tags) assert.match(t, /\sdata-dn="\d+"/, t);
  const ks = dnOf(r.html).map(([, k]) => k);
  assert.strictEqual(new Set(ks).size, ks.length);
  const by = new Map(dnOf(r.html).map(([tag, k]) => [tag, r.sources.get(k)]));
  assert.deepStrictEqual(by.get('div'), { file: 'boards/x.html', path: [0], kind: 'element', name: 'div' });
  assert.deepStrictEqual(by.get('b'), { file: 'boards/x.html', path: [0, 0, 0], kind: 'element', name: 'b' });
  assert.deepStrictEqual(by.get('img').path, [0, 1]);
  assert.deepStrictEqual(by.get('br').path, [0, 2]);
  assert.deepStrictEqual(by.get('span').path, [0, 3]);
  // the visual markup is unchanged: dropping data-dn gives the plain expansion
  assert.strictEqual(r.html.replace(/ data-dn="\d+"/g, ''), components.expand('<div class="a"><p>oi <b>x</b></p><img src="i.png"><br/><span>z</span></div>', comps({})).html);
});

test('annotate maps a component root to its call site and slot children to the caller', () => {
  const c = comps({
    Sidebar: '<nav class="w-48"><slot></slot><x-nav-item label="Fixo"></x-nav-item></nav>',
    NavItem: '<a class="p-2"><span>{{label}}</span></a>',
  });
  const r = components.expand('<main><h1>t</h1><x-sidebar><x-nav-item label="A"/><p>livre</p></x-sidebar></main>', c,
    { annotate: true, file: 'boards/conversas.html' });
  assert.deepStrictEqual(r.errors, []);
  assert.ok(!/data-dn-/.test(r.html), 'no temporary markers left');
  const list = dnOf(r.html).map(([tag, k]) => ({ tag, ...r.sources.get(k) }));
  assert.strictEqual(list.length, openTags(r.html).length);
  const nav = list.find((x) => x.tag === 'nav');
  assert.deepStrictEqual(nav, { tag: 'nav', file: 'components/Sidebar.html', path: [0], kind: 'component', name: 'Sidebar',
    call: { file: 'boards/conversas.html', path: [0, 1] } });
  const [a1, a2] = list.filter((x) => x.tag === 'a');
  assert.deepStrictEqual(a1.call, { file: 'boards/conversas.html', path: [0, 1, 0] }); // instance in the board (slot)
  assert.deepStrictEqual(a2.call, { file: 'components/Sidebar.html', path: [0, 1] }); // instance inside Sidebar
  assert.strictEqual(a1.kind, 'component');
  assert.strictEqual(a1.name, 'NavItem');
  const spans = list.filter((x) => x.tag === 'span');
  assert.deepStrictEqual(spans.map((s) => [s.file, s.path, s.kind]), [
    ['components/NavItem.html', [0, 0], 'element'], ['components/NavItem.html', [0, 0], 'element']]);
  const p = list.find((x) => x.tag === 'p');
  assert.deepStrictEqual([p.file, p.path], ['boards/conversas.html', [0, 1, 1]]);
});

test('annotate: a component whose root is another component keeps the outer instance', () => {
  const c = comps({ Outer: '<x-inner></x-inner>', Inner: '<div><i>k</i></div>' });
  const r = components.expand('<x-outer></x-outer>', c, { annotate: true, file: 'boards/b.html' });
  const [[, k]] = dnOf(r.html);
  assert.deepStrictEqual(r.sources.get(k), { file: 'components/Inner.html', path: [0], kind: 'component', name: 'Outer',
    call: { file: 'boards/b.html', path: [0] } });
});

test('annotate skips comments and script text, numbers raw-param elements, and keeps tailwind classes', () => {
  const c = comps({ T: '<u>{{{v}}}</u>' });
  const r = components.expand('<!-- <div> --><script>if (a<b) x("<p>")</script><x-t v="<em>r</em>"></x-t><div class="bg-red-500 p-[3px]"></div>', c,
    { annotate: true, file: 'boards/b.html' });
  assert.deepStrictEqual(r.errors, []);
  assert.match(r.html, /^<!-- <div> --><script data-dn="\d+">if \(a<b\) x\("<p>"\)<\/script>/);
  const em = dnOf(r.html).find(([t]) => t === 'em');
  assert.ok(em, r.html);
  assert.strictEqual(r.sources.get(em[1]).file, 'components/T.html'); // nearest annotated ancestor
  assert.match(r.html, /class="bg-red-500 p-\[3px\]"/);
});

test('without annotate the output and result shape are unchanged', () => {
  const r = components.expand('<div>a</div>', comps({}));
  assert.strictEqual(r.html, '<div>a</div>');
  assert.strictEqual(r.sources, undefined);
});
