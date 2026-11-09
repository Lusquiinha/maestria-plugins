'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { panel, stateOf, taskOf } = require('../lib/cards');

test('quem espera você ganha do cartão; sem cartão, o status ao vivo decide', () => {
  assert.equal(stateOf({ state: 'done' }, { needsYou: true }), 'needs_you');
  assert.equal(stateOf({ state: 'working' }, { status: 'idle' }), 'working');
  assert.equal(stateOf(null, { status: 'tool' }), 'working');
  assert.equal(stateOf(null, { status: 'idle' }), 'done');
  assert.equal(taskOf({ title: 'faz a task#88832', branch: '' }), 'TASK#88832');
});

test('o painel põe quem precisa de você em cima e mostra bullets, comando e pergunta', () => {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'gerente', manager: true });
  const a = l.add({ tabId: 'a', parent: g, name: 'a' });
  const b = l.add({ tabId: 'b', parent: g, name: 'b' });
  l.nodes[a].card = { state: 'done', bullets: ['feito X'], action: { kind: 'command', text: 'git push', where: 'zephryz' } };
  l.nodes[b].card = { state: 'working', bullets: [], action: { kind: 'question', text: 'qual branch?' } };
  const sessions = [
    { id: 'g', title: 'gerente' },
    { id: 'a', title: '● a', status: 'idle', statusLabel: 'Pronto' },
    { id: 'b', title: '● BUG#7 b', status: 'waitingAnswer', needsYou: true },
  ];
  const { title, blocks } = panel(l, g, sessions);
  assert.equal(title, 'painel · gerente');
  assert.match(blocks[0].subtitle, /^1 precisa de você · 0 trabalhando · 1 pronto$/);
  const [first, second] = blocks.slice(1).map((c) => c.children);
  assert.equal(first[0].title, 'BUG#7 b');
  assert.match(first[0].subtitle, /^precisa de você · BUG#7/);
  assert.deepEqual(first.find((x) => x.type === 'markdown'), { type: 'markdown', text: '**Pergunta:** qual branch?' });
  assert.equal(second[0].title, 'a');
  assert.equal(second.find((x) => x.type === 'code').text, 'git push');
  assert.equal(second.find((x) => x.type === 'row').children[0].action, 'copy:a');
  assert.equal(second.find((x) => x.style === 'faint').text, 'onde: zephryz');
});

test('com tabId na action o cartão leva até a aba: enviar (só comando), ir e o nome da aba no onde', () => {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'g', manager: true });
  const a = l.add({ tabId: 'a', parent: g, name: 'a' });
  const b = l.add({ tabId: 'b', parent: g, name: 'b' });
  const c = l.add({ tabId: 'c', parent: g, name: 'c' });
  l.nodes[a].card = { state: 'working', bullets: [], action: { kind: 'command', text: 'npm test', tabId: 'alvo' } };
  l.nodes[b].card = { state: 'working', bullets: [], action: { kind: 'question', text: 'ok?', tabId: 'alvo' } };
  l.nodes[c].card = { state: 'working', bullets: [], action: { kind: 'command', text: 'ls', tabId: 'sumiu' } };
  const sessions = [{ id: 'g' }, { id: 'a', title: 'a' }, { id: 'b', title: 'b' }, { id: 'c', title: 'c' }, { id: 'alvo', title: '● TASK#9 thumb' }];
  const cards = panel(l, g, sessions).blocks.slice(1).map((x) => x.children);
  const buttons = (ch) => ch.find((x) => x.type === 'row').children.map((x) => x.action);
  assert.deepEqual(buttons(cards[0]), ['send:a', 'copy:a', 'focus:alvo']);
  assert.equal(cards[0].find((x) => x.style === 'faint').text, 'onde: TASK#9 thumb');
  assert.deepEqual(buttons(cards[1]), ['focus:alvo']);
  assert.deepEqual(buttons(cards[2]), ['copy:c']);
  assert.match(cards[2].find((x) => x.style === 'faint').text, /aba fechada/);
});
