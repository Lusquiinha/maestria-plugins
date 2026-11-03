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
  assert.deepStrictEqual(by.get('div'), { file: 'boards/x.html', path: [0], tag: 'div', kind: 'element', name: 'div' });
  assert.deepStrictEqual(by.get('b'), { file: 'boards/x.html', path: [0, 0, 0], tag: 'b', kind: 'element', name: 'b' });
  assert.deepStrictEqual(by.get('img').path, [0, 1]);
  assert.deepStrictEqual(by.get('br').path, [0, 2]);
  assert.deepStrictEqual(by.get('span').path, [0, 3]);
  // the visual markup is unchanged: dropping data-dn gives the plain expansion
  assert.strictEqual(r.html.replace(/ data-dn="\d+"/g, ''), components.expand('<div class="a"><p>oi <b>x</b></p><img src="i.png"><br/><span>z</span></div>', comps({})).html);
});

const calls = (r) => [...r.sources].filter(([, x]) => x.kind === 'component');

test('annotate gives every component call its own record, written where the call is', () => {
  const c = comps({
    Sidebar: '<nav class="w-48"><slot></slot><x-nav-item label="Fixo"></x-nav-item></nav>',
    NavItem: '<a class="p-2"><span>{{label}}</span></a>',
  });
  const r = components.expand('<main><h1>t</h1><x-sidebar><x-nav-item label="A"/><p>livre</p></x-sidebar></main>', c,
    { annotate: true, file: 'boards/conversas.html' });
  assert.deepStrictEqual(r.errors, []);
  assert.ok(!/data-dn-/.test(r.html), 'no temporary markers left');
  const list = dnOf(r.html).map(([tag, k]) => ({ k, tag, ...r.sources.get(k) }));
  assert.strictEqual(list.length, openTags(r.html).length);
  const ks = list.map((x) => x.k);
  const cs = calls(r);
  assert.strictEqual(cs.length, 3);
  for (const [k] of cs) assert.ok(k > Math.max(...ks), 'call k come after the element k');
  const side = cs.find(([, x]) => x.name === 'Sidebar');
  assert.deepStrictEqual(side[1], { file: 'boards/conversas.html', path: [0, 1], tag: 'x-sidebar', kind: 'component', name: 'Sidebar',
    componentFile: 'components/Sidebar.html', call: { file: 'boards/conversas.html', path: [0, 1] } });
  const items = cs.filter(([, x]) => x.name === 'NavItem').map(([, x]) => [x.file, x.path, x.tag, x.inst]);
  assert.deepStrictEqual(items.sort(), [
    ['boards/conversas.html', [0, 1, 0], 'x-nav-item', undefined], // in the slot: written in the board
    ['components/Sidebar.html', [0, 1], 'x-nav-item', undefined], // inside Sidebar, not at its top level
  ].sort());
  // the template's top-level elements point at their own call
  const nav = list.find((x) => x.tag === 'nav');
  assert.deepStrictEqual(nav, { k: nav.k, tag: 'nav', file: 'components/Sidebar.html', path: [0], kind: 'element', name: 'nav', inst: side[0] });
  const as = list.filter((x) => x.tag === 'a');
  assert.deepStrictEqual(as.map((x) => r.sources.get(x.inst).file).sort(), ['boards/conversas.html', 'components/Sidebar.html']);
  const p = list.find((x) => x.tag === 'p');
  assert.deepStrictEqual([p.file, p.path, p.inst], ['boards/conversas.html', [0, 1, 1], undefined]);
});

test('annotate: a top-level call inside a template is its own instance, never relabelled', () => {
  const c = comps({ Card: '<div>a</div><x-badge></x-badge>', Badge: '<b>B</b>' });
  const r = components.expand('<x-card></x-card>', c, { annotate: true, file: 'boards/b.html' });
  const cs = new Map(calls(r).map(([k, x]) => [x.name, { k, ...x }]));
  const card = cs.get('Card');
  const badge = cs.get('Badge');
  assert.deepStrictEqual([card.file, card.path, card.tag, card.componentFile, card.inst], ['boards/b.html', [0], 'x-card', 'components/Card.html', undefined]);
  assert.deepStrictEqual([badge.file, badge.path, badge.tag, badge.componentFile, badge.inst], ['components/Card.html', [1], 'x-badge', 'components/Badge.html', card.k]);
  const els = new Map(dnOf(r.html).map(([t, k]) => [t, r.sources.get(k)]));
  assert.deepStrictEqual(els.get('div'), { file: 'components/Card.html', path: [0], tag: 'div', kind: 'element', name: 'div', inst: card.k });
  assert.deepStrictEqual(els.get('b'), { file: 'components/Badge.html', path: [0], tag: 'b', kind: 'element', name: 'b', inst: badge.k });
});

test('annotate: a component whose root is another component gives two consistent instances', () => {
  const c = comps({ Outer: '<x-inner></x-inner>', Inner: '<div><i>k</i></div>' });
  const r = components.expand('<x-outer></x-outer>', c, { annotate: true, file: 'boards/b.html' });
  const cs = new Map(calls(r).map(([k, x]) => [x.name, { k, ...x }]));
  const outer = cs.get('Outer');
  const inner = cs.get('Inner');
  assert.deepStrictEqual([outer.file, outer.path, outer.tag, outer.componentFile, outer.inst], ['boards/b.html', [0], 'x-outer', 'components/Outer.html', undefined]);
  assert.deepStrictEqual([inner.file, inner.path, inner.tag, inner.componentFile, inner.inst], ['components/Outer.html', [0], 'x-inner', 'components/Inner.html', outer.k]);
  const [[, k]] = dnOf(r.html);
  assert.deepStrictEqual(r.sources.get(k), { file: 'components/Inner.html', path: [0], tag: 'div', kind: 'element', name: 'div', inst: inner.k });
});

test('annotate skips comments and script text, numbers raw-param elements without a source, and keeps tailwind classes', () => {
  const c = comps({ T: '<u>{{{v}}}</u>' });
  const r = components.expand('<!-- <div> --><script>if (a<b) x("<p>")</script><x-t v="<em>r<i>j</i></em>"></x-t><div class="bg-red-500 p-[3px]"></div>', c,
    { annotate: true, file: 'boards/b.html' });
  assert.deepStrictEqual(r.errors, []);
  assert.match(r.html, /^<!-- <div> --><script data-dn="\d+">if \(a<b\) x\("<p>"\)<\/script>/);
  const em = dnOf(r.html).find(([t]) => t === 'em');
  assert.ok(em, r.html);
  const i = dnOf(r.html).find(([t]) => t === 'i');
  // written in an attribute value, not as an element: data-dn but no source (tree() drops them)
  assert.strictEqual(r.sources.has(em[1]), false);
  assert.strictEqual(r.sources.has(i[1]), false);
  const u = dnOf(r.html).find(([t]) => t === 'u');
  assert.strictEqual(r.sources.get(u[1]).file, 'components/T.html');
  assert.match(r.html, /class="bg-red-500 p-\[3px\]"/);
});

test('without annotate the output and result shape are unchanged', () => {
  const r = components.expand('<div>a</div>', comps({}));
  assert.strictEqual(r.html, '<div>a</div>');
  assert.strictEqual(r.sources, undefined);
});

// P2's use: every source record resolves, by scanElements at its path, to the
// element written there.
function roundTrip(sources, read) {
  const tags = new Map(); // file -> Map(path key -> tag)
  for (const [k, rec] of sources) {
    if (!tags.has(rec.file)) {
      const m = new Map();
      components.scanElements(read(rec.file), (t) => { m.set(t.path.join('.'), t.tag); });
      tags.set(rec.file, m);
    }
    const found = tags.get(rec.file).get(rec.path.join('.'));
    assert.strictEqual(found, rec.tag, `k ${k}: ${rec.file} [${rec.path}] is <${found}>, record says <${rec.tag}>`);
    if (rec.kind === 'element') assert.strictEqual(rec.name, rec.tag);
    if (rec.call) {
      const callTags = new Map();
      components.scanElements(read(rec.call.file), (t) => { callTags.set(t.path.join('.'), t.tag); });
      assert.match(callTags.get(rec.call.path.join('.')) || '', /^x-/, `k ${k}: call site is not an x- tag`);
    }
  }
}

test('round trip: every source of the bench board (sidebar as a component) resolves to its element', () => {
  const bench = path.join(__dirname, '..', 'bench', 'sac-sidebar', 'boards', 'conversas.html');
  const board = fs.readFileSync(bench, 'utf8');
  const aside = /<aside[\s\S]*<\/aside>/.exec(board)[0];
  const files = {
    'boards/conversas.html': board.replace(aside, '<x-sidebar></x-sidebar>'),
    'components/Sidebar.html': aside,
  };
  for (const [name, b] of [['plain', board], ['sidebar', files['boards/conversas.html']]]) {
    const r = components.expand(b, comps({ Sidebar: aside }), { annotate: true, file: 'boards/conversas.html' });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual([...r.sources.values()].filter((x) => x.kind === 'element').length, openTags(r.html).length, name);
    assert.strictEqual(calls(r).length, name === 'plain' ? 0 : 1);
    roundTrip(r.sources, (f) => (name === 'plain' ? board : files[f]));
  }
});

test('round trip: components fixture (slots, nesting, component root that is a component)', () => {
  const files = {
    'components/Sidebar.html': '<nav class="w-48"><h2>m</h2><slot></slot><x-nav-item label="Fixo"></x-nav-item><br><x-card><b>c</b></x-card></nav>',
    'components/NavItem.html': '<a class="p-2"><span>{{label}}</span><img src="i.png"/></a>',
    'components/Card.html': '<x-box><section><slot></slot></section></x-box>',
    'components/Box.html': '<div class="box"><slot/></div><p>após</p>',
    'boards/b.html': '<main><!-- <i> --><h1>t</h1><x-sidebar><x-nav-item label="A"/><p>livre <em>x</em></p></x-sidebar><x-card/></main>',
  };
  const c = comps(Object.fromEntries(Object.entries(files).filter(([f]) => f.startsWith('components/'))
    .map(([f, t]) => [f.slice(11, -5), t])));
  const r = components.expand(files['boards/b.html'], c, { annotate: true, file: 'boards/b.html' });
  assert.deepStrictEqual(r.errors, []);
  const els = [...r.sources.values()].filter((x) => x.kind === 'element');
  assert.strictEqual(els.length, openTags(r.html.replace(/<!--[\s\S]*?-->/g, '')).length);
  roundTrip(r.sources, (f) => files[f]);
  const cards = calls(r).filter(([, x]) => x.name === 'Card');
  assert.deepStrictEqual(cards.map(([, x]) => x.file).sort(), ['boards/b.html', 'components/Sidebar.html']);
  const boxes = calls(r).filter(([, x]) => x.name === 'Box');
  assert.strictEqual(boxes.length, 2);
  for (const [, x] of boxes) {
    assert.deepStrictEqual([x.file, x.path], ['components/Card.html', [0]]);
    assert.strictEqual(r.sources.get(x.inst).name, 'Card'); // a Card's root call: the Card is its parent
  }
});
