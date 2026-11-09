'use strict';
// A resposta de um cartão vai pro terminal da sessão (cópia na caixa do gerente), ou pro gerente se ela não pode receber.

const { bare } = require('./links');
const { PROMPT } = require('./cards');

const INBOX = 50;

/** Manda [text] pela sessão do nó [key] e passa o cartão pra "trabalhando". Devolve por onde foi. */
async function deliver(key, text, { links, request, sessions, now = Date.now() }) {
  const node = links.nodes[key];
  if (!node) throw new Error('esse cartão não existe mais');
  const body = String(text || '').trim();
  if (!body) throw new Error('resposta vazia');
  const parent = links.node(node.parent);
  const s = sessions.find((x) => x.id === node.tabId && !x.exited) || null;
  const title = bare(s ? s.title : node.name) || node.name;
  const toManager = !s || s.hibernated || PROMPT.has(s.status);
  if (toManager) {
    const m = parent && sessions.find((x) => x.id === parent.tabId && !x.exited);
    if (!m || m.hibernated || PROMPT.has(m.status)) throw new Error(`${title} não pode receber agora e o gerente também não: responda na aba`);
    const why = s ? s.statusLabel || s.status : 'fechada';
    await request('terminal.sendText', { tabId: parent.tabId, text: `[resposta do usuário no cartão de ${title} (${why})] ${body}`, submit: true });
  } else {
    await request('terminal.sendText', { tabId: s.id, text: body, submit: true });
    if (parent) parent.inbox = [...(parent.inbox || []), { tabId: s.id, title, text: body, at: now, via: 'terminal' }].slice(-INBOX);
  }
  node.card = { ...(node.card || {}), state: 'working', action: null, headline: `Você respondeu: ${body}`, since: now, answered: { text: body, at: now } };
  return { via: toManager ? 'manager' : 'terminal', title };
}

module.exports = { deliver };
