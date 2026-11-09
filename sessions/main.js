'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mx = require('./maestria');
const tools = require('./lib/tools');
const { Links, tinted, bare } = require('./lib/links');
const { sidebar } = require('./lib/tree');
const { panel } = require('./lib/cards');

const MANAGER_BRIEF = [
  'Você é um gerente de sessões na Maestria. Divida o trabalho e delegue: abra uma sessão por frente com sessions_open',
  '(cada pedido se sustenta sozinho, a sessão nova não sabe nada desta conversa), acompanhe com sessions_list (mine: true)',
  'e mande instruções com sessions_send. As sessões que você abre ganham a sua cor. Não faça o trabalho pesado você mesmo:',
  'coordene, junte os resultados e reporte.',
].join(' ');

const state = { links: new Links(), file: null, timer: null, panels: new Set() };
const PANEL = 'painel:';

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function save() {
  if (!state.file) return;
  try {
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    fs.writeFileSync(state.file, JSON.stringify(state.links.toJSON()));
  } catch (e) {
    mx.log('não salvou os vínculos:', e.message);
  }
  schedule();
}

function load() {
  try {
    state.links = new Links(JSON.parse(fs.readFileSync(state.file, 'utf8')));
  } catch {
    state.links = new Links();
  }
}

async function refresh() {
  const sessions = (await mx.request('sessions.list')) || [];
  if (state.links.reconcile(sessions)) {
    try {
      fs.writeFileSync(state.file, JSON.stringify(state.links.toJSON()));
    } catch {}
  }
  await mx.request('sidebar.update', sidebar(state.links, sessions));
  for (const key of [...state.panels]) {
    if (!state.links.nodes[key]) {
      state.panels.delete(key);
      continue;
    }
    const r = await mx.request('view.update', { viewId: PANEL + key, ...panel(state.links, key, sessions) }).catch(() => ({ open: false }));
    if (!r || r.open === false) state.panels.delete(key);
  }
}

/** Abre (ou traz pra tela) a janela de cartões do gerente [key]. */
async function showPanel(key, focus = false) {
  if (state.panels.has(key) && !focus) return schedule();
  const sessions = (await mx.request('sessions.list')) || [];
  await mx.request('view.open', { viewId: PANEL + key, ...panel(state.links, key, sessions) });
  state.panels.add(key);
}

function schedule() {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => refresh().catch((e) => mx.log('lateral:', e.message)), 300);
}

async function createManager(context = {}) {
  const folders = (await mx.request('folders.list').catch(() => [])) || [];
  const items = folders.map((f) => ({ value: f.root, label: f.name || path.basename(f.root), detail: f.root }));
  if (context.cwd && !items.some((i) => i.value === context.cwd)) items.unshift({ value: context.cwd, label: path.basename(context.cwd), detail: context.cwd });
  const cwd = await mx.request('window.pick', { title: 'novo gerente: pasta', items });
  if (!cwd) return;
  const name = await mx.request('window.input', { title: 'novo gerente: nome', placeholder: 'ex.: tarefas do Wiboor' });
  if (!name) return;
  const ask = await mx.request('window.input', { title: 'novo gerente: primeiro pedido', placeholder: 'o que ele deve coordenar (vazio: só abre)' }).catch(() => null);
  const key = state.links.add({ tabId: null, name, manager: true });
  const node = state.links.nodes[key];
  const params = { cwd, label: tinted(name, node.color), prompt: ask ? `${MANAGER_BRIEF}\n\nPedido: ${ask}` : MANAGER_BRIEF };
  try {
    const { tabId } = await mx.request('session.openClaude', params);
    node.tabId = tabId;
    save();
  } catch (e) {
    delete state.links.nodes[key];
    await mx.request('window.showBanner', { text: `sessions: não abriu o gerente: ${e.message}` }).catch(() => {});
  }
}

const ctx = ({ tabId, cwd }) => ({
  request: (method, params) => mx.request(method, params),
  home: os.homedir(),
  cwd,
  tabId,
  isDir,
  links: state.links,
  save,
  showPanel,
  log: (...a) => mx.log(...a),
});

mx.onRequest('initialize', (params) => {
  state.file = path.join(params.dataDir || path.join(os.homedir(), '.maestria-rs', 'plugin-data', 'maestria.sessions'), 'links.json');
  load();
  return {};
});

mx.onRequest('tool.call', ({ tool, args, tabId, cwd }) => tools.handle(tool, args, ctx({ tabId, cwd })));

mx.onRequest('command.invoke', ({ command, context }) => {
  if (command === 'gerente') createManager(context).catch((e) => mx.log('gerente:', e.message));
  return null;
});

mx.onNotification('event', ({ type }) => {
  if (type === 'sidebar.shown' || type === 'hook' || String(type).startsWith('session.')) schedule();
});

async function retitle(keys) {
  const sessions = (await mx.request('sessions.list')) || [];
  for (const key of keys) {
    const n = state.links.nodes[key];
    const s = n && sessions.find((x) => x.id === n.tabId);
    if (s) await mx.request('session.rename', { tabId: s.id, title: tinted(s.title, n.color) }).catch((e) => mx.log('rename:', e.message));
  }
}

async function onAction(act) {
  const [verb, a, b] = act.split(':');
  const links = state.links;
  const titleOf = async (tabId) => ((await mx.request('sessions.list')) || []).find((s) => s.id === tabId)?.title || tabId;
  if (verb === 'novo') return createManager();
  if (verb === 'focus') return mx.request('session.focus', { tabId: a });
  if (verb === 'panel') return showPanel(a, true);
  if (verb === 'send') {
    const n = links.nodes[links.byTab(a)];
    const act = n && n.card && n.card.action;
    if (!act || act.kind !== 'command' || !act.tabId) return null;
    await mx.request('terminal.sendText', { tabId: act.tabId, text: act.text, submit: false });
    return mx.request('session.focus', { tabId: act.tabId });
  }
  if (verb === 'copy') {
    const n = links.nodes[links.byTab(a)];
    const text = n && n.card && n.card.action && n.card.action.text;
    if (!text) return null;
    await mx.request('clipboard.write', { text });
    return mx.request('window.showBanner', { text: 'comando copiado' }).catch(() => {});
  }
  if (verb === 'manager') {
    const { key } = links.ensure(a, await titleOf(a));
    save();
    return retitle([key]);
  }
  if (verb === 'promote') {
    links.promote(a);
    save();
    return retitle(links.subtree(a));
  }
  if (verb === 'link') {
    const key = links.link(b, a, await titleOf(b));
    save();
    return retitle(links.subtree(key));
  }
  if (verb === 'unlink') {
    const n = links.nodes[a];
    links.remove(a);
    save();
    if (n) await mx.request('session.rename', { tabId: n.tabId, title: bare(await titleOf(n.tabId)) }).catch(() => {});
    return null;
  }
  if (verb === 'forget') {
    links.remove(a);
    save();
  }
  return null;
}

mx.onNotification('view.action', ({ viewId, action, values }) => {
  if (viewId !== 'sidebar' && !String(viewId).startsWith(PANEL)) return;
  const act = String(action || (values && values.action) || '');
  onAction(act).catch((e) => {
    mx.log('ação', act, e.message);
    mx.request('window.showBanner', { text: `sessions: ${e.message}` }).catch(() => {});
  });
});

mx.start();
