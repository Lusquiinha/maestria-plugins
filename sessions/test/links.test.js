'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links, tinted, bare } = require('../lib/links');
const { sidebar } = require('../lib/tree');

test('tinted troca a cor da frente em vez de empilhar', () => {
  assert.equal(tinted('a', 'red'), '● a');
  assert.equal(tinted('▲ a', 'red'), '● a');
  assert.equal(bare('🟩  b'), 'b');
});

test('reconcile segue o sessionId quando o tabId muda e esquece o que sumiu há dias', () => {
  let now = 0;
  const l = new Links({}, () => now);
  const root = l.add({ tabId: 't1', name: 'g', manager: true });
  const child = l.add({ tabId: 't2', parent: root, name: 'c' });
  const gone = l.add({ tabId: 't3', parent: child, name: 'x' });
  l.reconcile([{ id: 't1', sessionId: 's1' }, { id: 't2', sessionId: 's2' }]);
  assert.equal(l.nodes[root].sessionId, 's1');
  now = 1000;
  l.reconcile([{ id: 'novo1', sessionId: 's1' }, { id: 'novo2', sessionId: 's2' }]);
  assert.equal(l.nodes[root].tabId, 'novo1');
  assert.equal(l.nodes[child].tabId, 'novo2');
  assert.ok(l.nodes[gone]);
  now = 4 * 24 * 3600 * 1000;
  l.reconcile([{ id: 'novo1', sessionId: 's1' }, { id: 'novo2', sessionId: 's2' }]);
  assert.equal(l.nodes[gone], undefined);
});

test('um tabId reaproveitado por outra conversa não herda o nó', () => {
  const l = new Links({}, () => 0);
  const k = l.add({ tabId: 't1', name: 'g' });
  l.reconcile([{ id: 't1', sessionId: 's1' }]);
  l.reconcile([{ id: 't1', sessionId: 'outra' }]);
  assert.equal(l.nodes[k].tabId, 't1');
  assert.equal(l.nodes[k].seenAt, 0);
});

test('a lateral desenha a árvore na cor do gerente, com o selo de quem espera você', () => {
  const l = new Links({}, () => 0);
  const root = l.add({ tabId: 't1', name: 'gerente', manager: true });
  l.add({ tabId: 't2', parent: root, name: 'filho' });
  l.add({ tabId: 't3', parent: root, name: 'fechado' });
  const { blocks, badge } = sidebar(l, [
    { id: 't1', title: '● gerente', status: 'working', statusLabel: 'pensando' },
    { id: 't2', title: '● filho', status: 'waitingAnswer', statusLabel: 'pergunta', needsYou: true, activity: { lastPrompt: 'faz X' } },
  ]);
  const items = blocks[1].items;
  assert.deepEqual(items.map((i) => [i.title, i.avatar.color]), [['gerente', '#E5534B'], ['├─ filho', '#E5534B'], ['└─ fechado', '#E5534B']]);
  assert.equal(items[1].subtitle, 'pergunta · faz X');
  assert.equal(items[1].status, 'yellow');
  assert.equal(items[1].action, 'focus:t2');
  assert.equal(items[2].dim, true);
  assert.equal(badge, '1');
});

test('a árvore desenha os galhos do tree em mais de um nível', () => {
  const l = new Links({}, () => 0);
  const r = l.add({ tabId: 'a', name: 'g', manager: true });
  const c1 = l.add({ tabId: 'b', parent: r, name: 'c1' });
  l.add({ tabId: 'c', parent: c1, name: 'n1' });
  l.add({ tabId: 'd', parent: r, name: 'c2' });
  const live = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id }));
  const titles = sidebar(l, live).blocks[1].items.map((i) => i.title);
  assert.deepEqual(titles, ['a', '├─ b', '│   └─ c', '└─ d']);
});

test('as sessões soltas aparecem embaixo com tornar gerente e ligar a um gerente', () => {
  const l = new Links({}, () => 0);
  const r = l.add({ tabId: 'a', name: 'g', manager: true });
  const { blocks } = sidebar(l, [{ id: 'a', kind: 'claude', title: 'g' }, { id: 'x', kind: 'claude', title: 'solta' }, { id: 'sh', kind: 'shell', title: 'sh' }]);
  assert.equal(blocks[2].type, 'section');
  const [solta] = blocks[3].items;
  assert.equal(solta.title, 'solta');
  assert.equal(solta.menu[0].action, 'manager:x');
  assert.deepEqual(solta.menu[1].children.map((c) => c.action), [`link:${r}:x`]);
});

test('link move a subárvore pra cor do novo pai e recusa ciclo; promote dá cor nova; remove sobe os filhos', () => {
  const l = new Links({}, () => 0);
  const red = l.add({ tabId: 'a', name: 'r', manager: true });
  const blue = l.add({ tabId: 'b', name: 'b', manager: true });
  const kid = l.add({ tabId: 'k', parent: blue, name: 'k' });
  const grand = l.add({ tabId: 'g', parent: kid, name: 'g' });
  l.link('k', red);
  assert.equal(l.nodes[kid].parent, red);
  assert.equal(l.nodes[grand].color, 'red');
  assert.throws(() => l.link('a', grand), /ciclo/);
  l.promote(kid);
  assert.equal(l.nodes[kid].parent, null);
  assert.notEqual(l.nodes[kid].color, 'red');
  assert.equal(l.nodes[grand].color, l.nodes[kid].color);
  l.remove(kid);
  assert.equal(l.nodes[grand].parent, null);
  const fresh = l.link('novo', red, 'novo');
  assert.equal(l.nodes[fresh].color, 'red');
});
