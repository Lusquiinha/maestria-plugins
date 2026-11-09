'use strict';
// main.js liga `tool.call` a handle(). ctx: { request, home, cwd, tabId, isDir, links, save, showPanel, log } (os testes passam um falso).

const path = require('path');
const { tinted, colorOf } = require('./links');
const { STATES, MAX_BULLETS } = require('./cards');

const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

class ToolError extends Error {}

function resolveCwd(cwd, { home, cwd: base, isDir }) {
  const raw = String(cwd || '').trim();
  if (!raw) throw new ToolError('cwd é obrigatório.');
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded) && !base) throw new ToolError(`cwd precisa ser absoluto ou começar com ~/: ${raw}`);
  const dir = path.resolve(base || '/', expanded);
  if (!isDir(dir)) throw new ToolError(`Pasta não existe: ${dir}`);
  return dir;
}

const sessionsOf = async (ctx) => (await ctx.request('sessions.list')) || [];

async function liveTab(ctx, tabId) {
  const s = (await sessionsOf(ctx)).find((x) => x.id === tabId && !x.exited);
  if (!s) throw new ToolError(`Nenhuma sessão aberta com tabId ${tabId}; veja sessions_list.`);
  return s;
}

/** Quem chama vira (ou já é) o nó pai; uma sessão solta ganha a cor nova no nome da aba. */
async function parentOf(ctx) {
  const { links } = ctx;
  if (!ctx.tabId) return null;
  const existing = links.byTab(ctx.tabId);
  if (existing) {
    links.nodes[existing].manager = true;
    return existing;
  }
  const me = (await sessionsOf(ctx)).find((s) => s.id === ctx.tabId);
  const { key } = links.ensure(ctx.tabId, me ? me.title : 'gerente');
  const title = tinted(links.nodes[key].name, links.nodes[key].color);
  await ctx.request('session.rename', { tabId: ctx.tabId, title }).catch((e) => ctx.log && ctx.log('rename do gerente:', e.message));
  return key;
}

async function open({ cwd, name, prompt }, ctx) {
  const dir = resolveCwd(cwd, ctx);
  const label = String(name || '').trim();
  if (!label) throw new ToolError('name é obrigatório.');
  const parent = await parentOf(ctx);
  const color = parent ? ctx.links.nodes[parent].color : null;
  const params = { cwd: dir, label: color ? tinted(label, color) : label, background: true };
  const text = String(prompt || '').trim();
  if (text) params.prompt = text;
  const { tabId } = (await ctx.request('session.openClaude', params)) || {};
  if (!tabId) throw new ToolError('A Maestria não devolveu a aba da sessão nova.');
  if (parent) ctx.links.add({ tabId, parent, name: label });
  ctx.save();
  return ok({ tabId, name: params.label, cwd: dir, prompted: Boolean(text), color: color ? colorOf(color).id : null });
}

function summary(s, links) {
  const key = links.byTab(s.id);
  const n = links.node(key);
  const parent = n && links.node(n.parent);
  const act = s.activity || {};
  return {
    tabId: s.id,
    kind: s.kind,
    title: s.title,
    cwd: s.cwd,
    branch: s.branch ?? null,
    status: s.status ?? null,
    statusLabel: s.statusLabel ?? null,
    needsYou: Boolean(s.needsYou),
    hibernated: Boolean(s.hibernated),
    color: n ? colorOf(n.color).id : null,
    parentTabId: parent ? parent.tabId : null,
    manager: Boolean(n && n.manager),
    lastPrompt: act.lastPrompt ?? null,
    lastMessage: act.lastMessage ?? null,
  };
}

async function list({ mine }, ctx) {
  const all = (await sessionsOf(ctx)).filter((s) => !s.exited && !s.embedded);
  if (ctx.links.reconcile(all)) ctx.save();
  let out = all.map((s) => summary(s, ctx.links));
  if (mine) {
    const me = ctx.links.byTab(ctx.tabId);
    out = out.filter((s) => me && s.parentTabId === ctx.tabId);
  }
  return ok({ sessions: out });
}

async function send({ tabId, text }, ctx) {
  const body = String(text || '').trim();
  if (!body) throw new ToolError('text é obrigatório.');
  if (tabId === ctx.tabId) throw new ToolError('Não dá pra mandar mensagem pra própria sessão.');
  const s = await liveTab(ctx, tabId);
  if (s.kind !== 'claude') throw new ToolError(`A aba ${tabId} não é uma sessão do claude.`);
  if (s.hibernated) throw new ToolError(`A sessão ${tabId} está hibernada; peça pro usuário acordá-la.`);
  if (s.status === 'waitingPermission' || s.status === 'waitingAnswer') {
    throw new ToolError(`A sessão ${tabId} está esperando o usuário (${s.statusLabel || s.status}); a mensagem cairia no meio da pergunta.`);
  }
  await ctx.request('terminal.sendText', { tabId, text: body, submit: true });
  return ok({ tabId, sent: true, wasBusy: s.status === 'working' || s.status === 'tool' });
}

async function rename({ tabId, name }, ctx) {
  const label = String(name || '').trim();
  if (!label) throw new ToolError('name é obrigatório.');
  await liveTab(ctx, tabId);
  const n = ctx.links.node(ctx.links.byTab(tabId));
  const title = n ? tinted(label, n.color) : label;
  const r = await ctx.request('session.rename', { tabId, title });
  if (n) {
    n.name = label;
    ctx.save();
  }
  return ok({ tabId, title: (r && r.title) || title });
}

async function card({ tabId, state, bullets, action }, ctx) {
  if (!STATES.includes(state)) throw new ToolError(`state precisa ser um de: ${STATES.join(', ')}.`);
  const list = (Array.isArray(bullets) ? bullets : []).map((b) => String(b).trim()).filter(Boolean);
  if (list.length > MAX_BULLETS) throw new ToolError(`No máximo ${MAX_BULLETS} bullets por cartão.`);
  if (action && (!action.text || !['command', 'question'].includes(action.kind))) {
    throw new ToolError('action precisa de text e de kind "command" ou "question".');
  }
  const s = await liveTab(ctx, tabId);
  if (action && action.tabId) await liveTab(ctx, action.tabId);
  const parent = await parentOf(ctx);
  if (!parent) throw new ToolError('Só um gerente escreve cartões: chame de uma sessão da Maestria.');
  const { links } = ctx;
  let key = links.byTab(tabId);
  if (!key || !links.subtree(parent).includes(key)) {
    key = links.link(tabId, parent, s.title);
    await ctx.request('session.rename', { tabId, title: tinted(s.title, links.nodes[key].color) }).catch(() => {});
  }
  links.nodes[key].card = {
    state,
    bullets: list,
    action: action
      ? { kind: action.kind, text: String(action.text), where: action.where ? String(action.where) : null, tabId: action.tabId || null }
      : null,
    at: Date.now(),
  };
  ctx.save();
  if (ctx.showPanel) await ctx.showPanel(links.rootOf(key));
  return ok({ tabId, state, cards: links.subtree(links.rootOf(key)).length - 1 });
}

const HANDLERS = { sessions_open: open, sessions_list: list, sessions_send: send, sessions_rename: rename, sessions_card: card };

async function handle(name, args, ctx) {
  const fn = HANDLERS[name];
  if (!fn) return fail(`ferramenta desconhecida: ${name}`);
  try {
    return await fn(args || {}, ctx);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (!(e instanceof ToolError) && ctx.log) ctx.log(`ferramenta ${name} falhou:`, msg);
    return fail(msg);
  }
}

module.exports = { handle, resolveCwd, ToolError };
