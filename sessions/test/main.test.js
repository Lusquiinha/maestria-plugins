'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const handlers = { req: {}, note: {} };
const calls = [];
const queue = {};
const sessions = [
  { id: 'g', kind: 'claude', title: 'g', status: 'idle' },
  { id: 'w', kind: 'claude', title: 'w', status: 'idle', sessionId: null },
];
const fake = {
  request: async (m, p) => {
    calls.push([m, p]);
    if (queue[m] && queue[m].length) return queue[m].shift();
    if (m === 'sessions.list') return sessions;
    if (m === 'view.update' || m === 'view.open') return { open: true };
    return null;
  },
  onRequest: (m, fn) => (handlers.req[m] = fn),
  onNotification: (m, fn) => (handlers.note[m] = fn),
  start() {},
  log() {},
};
const load = Module._load;
Module._load = function (r, parent, ...rest) {
  if (r === './maestria' && parent && parent.filename === path.join(root, 'main.js')) return fake;
  return load.call(this, r, parent, ...rest);
};
require(path.join(root, 'main.js'));
Module._load = load;

const tick = () => new Promise((r) => setTimeout(r, 20));

test('um cartão já respondido (action null) ainda manda a resposta nova pro terminal', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', action: { kind: 'question', text: 'sigo?', options: [{ label: 'sim' }] } } });
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(nodes).find((k) => nodes[k].tabId === 'w');
  const act = (a, extra = {}) => handlers.note['view.action']({ viewId: `painel:${key}`, action: 'act', values: { a, ...extra } });
  const sent = () => calls.filter(([m]) => m === 'terminal.sendText').map(([, p]) => [p.tabId, p.text]);
  act(`option:${key}:0`);
  await tick();
  const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes[key].card;
  assert.equal(after.action, null);
  assert.equal(after.answered.text, 'A: sim');
  act(`answer:${key}`, { text: '  e agora o backend  ' });
  await tick();
  assert.deepEqual(sent(), [['w', 'A: sim'], ['w', 'e agora o backend']]);
});

test('depois de abrir o painel, os refresh mandam só os dados (o template de novo zera a rolagem)', async () => {
  const panels = () => calls.filter(([m, p]) => (m === 'view.open' || m === 'view.update') && String(p.viewId).startsWith('painel:'));
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working', headline: 'de novo' } });
  await new Promise((r) => setTimeout(r, 400));
  const all = panels();
  const first = all.findIndex(([, p]) => p.rfw);
  assert.ok(first >= 0);
  const later = all.slice(first + 1);
  assert.ok(later.length > 0);
  for (const [, p] of later) {
    assert.equal(p.rfw, undefined);
    assert.ok(p.data);
  }
});

test('a caixa do topo manda direto pro gerente e a do cartão feito abre e fecha', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'done' } });
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const g = Object.keys(nodes).find((k) => nodes[k].tabId === 'g');
  const before = calls.length;
  handlers.note['view.action']({ viewId: `painel:${g}`, action: 'act', values: { a: `tell:${g}`, text: '  como está o ceph?  ' } });
  await tick();
  const sent = calls.slice(before).filter(([m]) => m === 'terminal.sendText').map(([, p]) => [p.tabId, p.text, p.submit]);
  assert.deepEqual(sent, [['g', 'como está o ceph?', true]]);
});

test('novo gerente em outra pasta: pede o caminho até ser uma pasta, aceita ~', async () => {
  const home = os.homedir();
  const sub = fs.mkdtempSync(path.join(home, '.sessions-test-'));
  try {
    queue['folders.list'] = [[{ root: '/var/www/x', name: 'x' }]];
    queue['window.pick'] = [':outra-pasta'];
    queue['window.input'] = ['/nao/existe/mesmo', `~/${path.basename(sub)}`, 'meu gerente', ''];
    queue['session.openClaude'] = [{ tabId: 'novo' }];
    const before = calls.length;
    handlers.note['view.action']({ viewId: 'sidebar', action: 'novo' });
    await tick();
    const mine = calls.slice(before);
    const pick = mine.find(([m]) => m === 'window.pick')[1];
    assert.deepEqual(pick.items.map((i) => i.value), ['/var/www/x', ':outra-pasta']);
    assert.ok(mine.some(([m, p]) => m === 'window.showBanner' && p.text === 'não é uma pasta: /nao/existe/mesmo'));
    const open = mine.find(([m]) => m === 'session.openClaude')[1];
    assert.equal(open.cwd, sub);
    assert.match(open.label, /^(\S)\1 meu gerente$/u);
  } finally {
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

test('mensagem pela caixa de um cartão de comando chega na aba sem apagar o comando nem mudar o estado', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', headline: 'rode isso', action: { kind: 'command', text: 'make deploy' } } });
  const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(read()).find((k) => read()[k].tabId === 'w');
  const before = calls.length;
  handlers.note['view.action']({ viewId: `painel:${key}`, action: 'act', values: { a: `message:${key}`, text: 'olha os logs antes' } });
  await tick();
  assert.deepEqual(calls.slice(before).filter(([m]) => m === 'terminal.sendText').map(([, p]) => [p.tabId, p.text]), [['w', 'olha os logs antes']]);
  const card = read()[key].card;
  assert.deepEqual([card.state, card.headline, card.action.text, card.answered.text, card.answered.message], ['needs_you', 'rode isso', 'make deploy', 'olha os logs antes', true]);
});
