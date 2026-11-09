'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../lib/tools');
const { Links } = require('../lib/links');

function makeCtx(over = {}) {
  const calls = [];
  const sessions = over.sessions || [{ id: 'me', kind: 'claude', title: 'coordenador', cwd: '/home/u' }];
  let saved = 0;
  const ctx = {
    calls,
    home: '/home/u',
    tabId: 'me',
    isDir: (p) => ['/home/u', '/home/u/repo', '/srv/app'].includes(p),
    links: new Links({}, () => 1000),
    save: () => saved++,
    saves: () => saved,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'session.openClaude') return { tabId: 'tab9' };
      if (method === 'sessions.list') return sessions;
      if (method === 'session.rename') return { title: params.title };
      return null;
    },
    log: () => {},
    ...over,
  };
  return ctx;
}

const body = (res) => JSON.parse(res.content[0].text);
const opened = (ctx) => ctx.calls.find((c) => c.method === 'session.openClaude');

test('sessions_open abre em segundo plano, com a cor de quem chama no nome e o primeiro pedido', async () => {
  const ctx = makeCtx();
  const res = await tools.handle('sessions_open', { cwd: '~/repo', name: 'TASK#1', prompt: '  faz X  ' }, ctx);
  assert.equal(res.isError, undefined);
  assert.deepEqual(opened(ctx).params, { cwd: '/home/u/repo', label: '● TASK#1', background: true, prompt: 'faz X' });
  assert.deepEqual(body(res), { tabId: 'tab9', name: '● TASK#1', cwd: '/home/u/repo', prompted: true, color: 'red' });
});

test('quem chama vira gerente: a aba dele ganha a cor, e a nova fica ligada a ele', async () => {
  const ctx = makeCtx();
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'a' }, ctx);
  assert.deepEqual(ctx.calls.find((c) => c.method === 'session.rename').params, { tabId: 'me', title: '● coordenador' });
  const me = ctx.links.byTab('me');
  const child = ctx.links.byTab('tab9');
  assert.equal(ctx.links.nodes[me].manager, true);
  assert.equal(ctx.links.nodes[child].parent, me);
  assert.equal(ctx.links.nodes[child].color, 'red');
  assert.equal(ctx.saves(), 1);
});

test('um filho que abre outra sessão passa a mesma cor adiante, sem renomear de novo', async () => {
  const ctx = makeCtx();
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'filho' }, ctx);
  ctx.tabId = 'tab9';
  ctx.calls.length = 0;
  ctx.request = async (method, params) => {
    ctx.calls.push({ method, params });
    return method === 'session.openClaude' ? { tabId: 'tab10' } : [];
  };
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'neto' }, ctx);
  assert.equal(body(res).color, 'red');
  assert.equal(ctx.calls.some((c) => c.method === 'session.rename'), false);
  assert.equal(ctx.links.nodes[ctx.links.byTab('tab10')].parent, ctx.links.byTab('tab9'));
});

test('gerentes diferentes ganham cores diferentes', async () => {
  const ctx = makeCtx({ sessions: [{ id: 'me', title: 'a' }, { id: 'other', title: 'b' }] });
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'x' }, ctx);
  ctx.tabId = 'other';
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'y' }, ctx);
  assert.equal(body(res).color, 'blue');
});

test('sessions_open sem pedido não manda prompt', async () => {
  const ctx = makeCtx();
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'app' }, ctx);
  assert.equal(opened(ctx).params.prompt, undefined);
  assert.equal(body(res).prompted, false);
});

test('sessions_open resolve pasta relativa contra o cwd de quem chama e tira a barra do fim', async () => {
  const ctx = makeCtx({ cwd: '/home/u' });
  const res = await tools.handle('sessions_open', { cwd: 'repo/', name: 'a' }, ctx);
  assert.equal(opened(ctx).params.cwd, '/home/u/repo');
  assert.equal(body(res).cwd, '/home/u/repo');
});

test('sessions_open recusa pasta relativa sem cwd de quem chama, inexistente e nome vazio sem abrir nada', async () => {
  for (const args of [{ cwd: 'repo', name: 'a' }, { cwd: '/nada', name: 'a' }, { cwd: '/srv/app', name: '  ' }, { name: 'a' }]) {
    const ctx = makeCtx();
    const res = await tools.handle('sessions_open', args, ctx);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(ctx.calls.length, 0);
  }
});

test('sessions_open falha quando a Maestria não devolve tabId', async () => {
  const ctx = makeCtx();
  const base = ctx.request;
  ctx.request = async (m, p) => (m === 'session.openClaude' ? {} : base(m, p));
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'a' }, ctx);
  assert.equal(res.isError, true);
});

test('erro da Maestria vira resultado de erro e vai pro log', async () => {
  const logged = [];
  const ctx = makeCtx({ tabId: null, request: async () => { throw new Error('sem permissão sessions.create'); }, log: (...a) => logged.push(a.join(' ')) });
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'a' }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /sessions\.create/);
  assert.equal(logged.length, 1);
});

test('sessions_list resume, traz gerente, cor e última atividade, e deixa de fora encerradas e embutidas', async () => {
  const sessions = [
    { id: 'me', kind: 'claude', title: 'A', cwd: '/r', branch: 'main', status: 'idle', statusLabel: 'Parado', sessionId: 's1' },
    { id: 'tab2', kind: 'shell', title: 'B', cwd: '/r', exited: true },
    { id: 'tab3', kind: 'shell', title: 'C', cwd: '/r', embedded: true },
    { id: 'tab9', kind: 'claude', title: 'D', cwd: '/s', status: 'waitingAnswer', needsYou: true, activity: { lastPrompt: 'faz', lastMessage: 'pergunta?' } },
  ];
  const ctx = makeCtx({ sessions });
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'D' }, ctx);
  const all = body(await tools.handle('sessions_list', {}, ctx)).sessions;
  assert.deepEqual(all.map((s) => s.tabId), ['me', 'tab9']);
  assert.deepEqual(all[1], {
    tabId: 'tab9', kind: 'claude', title: 'D', cwd: '/s', branch: null, status: 'waitingAnswer', statusLabel: null,
    needsYou: true, hibernated: false, color: 'red', parentTabId: 'me', manager: false, lastPrompt: 'faz', lastMessage: 'pergunta?',
  });
  assert.equal(all[0].manager, true);
  const mine = body(await tools.handle('sessions_list', { mine: true }, ctx)).sessions;
  assert.deepEqual(mine.map((s) => s.tabId), ['tab9']);
});

test('sessions_send manda pro terminal e recusa quando não dá', async () => {
  const sessions = [
    { id: 'me', kind: 'claude' },
    { id: 'ok', kind: 'claude', status: 'idle' },
    { id: 'sh', kind: 'shell' },
    { id: 'zz', kind: 'claude', hibernated: true },
    { id: 'ask', kind: 'claude', status: 'waitingPermission' },
  ];
  const ctx = makeCtx({ sessions });
  const res = await tools.handle('sessions_send', { tabId: 'ok', text: ' vai ' }, ctx);
  assert.deepEqual(ctx.calls.at(-1), { method: 'terminal.sendText', params: { tabId: 'ok', text: 'vai', submit: true } });
  assert.equal(body(res).sent, true);
  for (const args of [{ tabId: 'me', text: 'x' }, { tabId: 'nada', text: 'x' }, { tabId: 'sh', text: 'x' }, { tabId: 'zz', text: 'x' }, { tabId: 'ask', text: 'x' }, { tabId: 'ok', text: ' ' }]) {
    ctx.calls.length = 0;
    const r = await tools.handle('sessions_send', args, ctx);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(ctx.calls.some((c) => c.method === 'terminal.sendText'), false);
  }
});

test('sessions_rename mantém a cor de uma sessão ligada', async () => {
  const ctx = makeCtx({ sessions: [{ id: 'me', title: 'a' }, { id: 'tab9', title: '● x' }, { id: 'loose', title: 'y' }] });
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'x' }, ctx);
  let res = await tools.handle('sessions_rename', { tabId: 'tab9', name: 'novo nome' }, ctx);
  assert.equal(body(res).title, '● novo nome');
  res = await tools.handle('sessions_rename', { tabId: 'loose', name: 'solto' }, ctx);
  assert.equal(body(res).title, 'solto');
  assert.equal((await tools.handle('sessions_rename', { tabId: 'nada', name: 'z' }, ctx)).isError, true);
});

test('ferramenta desconhecida', async () => {
  const res = await tools.handle('sessions_nada', {}, makeCtx());
  assert.equal(res.isError, true);
});

test('sessions_card guarda o cartão, liga a sessão ao gerente e abre o painel', async () => {
  const sessions = [{ id: 'me', kind: 'claude', title: 'g' }, { id: 'w', kind: 'claude', title: 'TASK#5 worker' }];
  const shown = [];
  const ctx = makeCtx({ sessions, showPanel: async (k) => shown.push(k) });
  const res = await tools.handle('sessions_card', { tabId: 'w', state: 'needs_you', bullets: ['a', ' ', 'b'], action: { kind: 'question', text: 'posso?' } }, ctx);
  assert.equal(res.isError, undefined);
  const me = ctx.links.byTab('me');
  const w = ctx.links.nodes[ctx.links.byTab('w')];
  assert.equal(w.parent, me);
  assert.deepEqual({ ...w.card, at: 0 }, { state: 'needs_you', bullets: ['a', 'b'], action: { kind: 'question', text: 'posso?', where: null, tabId: null }, at: 0 });
  assert.deepEqual(shown, [me]);
  assert.ok(ctx.calls.some((c) => c.method === 'session.rename' && c.params.tabId === 'w' && c.params.title === '● TASK#5 worker'));
});

test('sessions_card recusa estado, bullets e action inválidos', async () => {
  const sessions = [{ id: 'me', kind: 'claude' }, { id: 'w', kind: 'claude' }];
  for (const args of [
    { tabId: 'w', state: 'feito' },
    { tabId: 'w', state: 'done', bullets: ['1', '2', '3', '4'] },
    { tabId: 'w', state: 'done', action: { kind: 'x', text: 'a' } },
    { tabId: 'nada', state: 'done' },
    { tabId: 'w', state: 'done', action: { kind: 'command', text: 'ls', tabId: 'nada' } },
  ]) {
    const ctx = makeCtx({ sessions });
    assert.equal((await tools.handle('sessions_card', args, ctx)).isError, true, JSON.stringify(args));
  }
});
