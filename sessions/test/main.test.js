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
const sessions = [
  { id: 'g', kind: 'claude', title: 'g', status: 'idle' },
  { id: 'w', kind: 'claude', title: 'w', status: 'idle', sessionId: null },
];
const fake = {
  request: async (m, p) => {
    calls.push([m, p]);
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
