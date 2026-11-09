'use strict';
// O painel do gerente: uma janela por gerente, um cartão por sessão que ele conduz, ao vivo.

const { colorOf, bare } = require('./links');

const STATES = ['working', 'needs_you', 'done'];
const LABEL = { needs_you: 'precisa de você', working: 'trabalhando', done: 'pronto' };
const TONE = { needs_you: 'red', working: 'yellow', done: 'green' };
const ORDER = { needs_you: 0, working: 1, done: 2 };
const MAX_BULLETS = 3;

const taskOf = (s) => {
  const m = `${s.title || ''} ${s.branch || ''}`.match(/\b(TASK|BUG)#\d+/i);
  return m ? m[0].toUpperCase() : null;
};

/** O estado que vale: a sessão esperando você ganha do que o gerente escreveu. */
function stateOf(card, session) {
  if (session && session.needsYou) return 'needs_you';
  if (card && card.state) return card.state;
  if (!session) return 'done';
  return session.status === 'idle' || session.status === 'ready' ? 'done' : 'working';
}

function cardBlock({ node, session, card }, live = new Map()) {
  const state = stateOf(card, session);
  const color = colorOf(node.color);
  const title = bare(session ? session.title : node.name) || node.name;
  const task = session ? taskOf(session) : null;
  const now = session ? session.statusLabel || session.status : 'fechada';
  const children = [
    {
      type: 'header',
      title,
      subtitle: [LABEL[state], task, now].filter(Boolean).join(' · '),
      tone: TONE[state],
      avatar: { shape: 'circle', color: color.hex, text: '' },
      status: TONE[state],
      actions: session ? [{ action: `focus:${session.id}`, icon: 'open', tooltip: 'ir pra sessão' }] : [],
    },
  ];
  const bullets = (card && card.bullets) || [];
  if (bullets.length) children.push({ type: 'markdown', text: bullets.map((b) => `- ${b}`).join('\n') });
  else if (session && session.activity && session.activity.lastMessage) {
    children.push({ type: 'text', style: 'dim', text: String(session.activity.lastMessage).slice(0, 280) });
  }
  const action = card && card.action;
  if (action && action.text) {
    const target = action.tabId ? live.get(action.tabId) : null;
    const buttons = [];
    if (action.kind === 'command') {
      children.push({ type: 'code', text: action.text });
      if (target) buttons.push({ type: 'button', action: `send:${node.tabId}`, label: 'enviar para a aba', icon: 'continue', style: 'primary' });
      buttons.push({ type: 'button', action: `copy:${node.tabId}`, label: 'copiar', icon: 'copy' });
    } else {
      children.push({ type: 'markdown', text: `**Pergunta:** ${action.text}` });
    }
    if (target) buttons.push({ type: 'button', action: `focus:${target.id}`, label: 'ir para a aba', icon: 'open' });
    const closed = action.tabId && !target;
    const where = target ? bare(target.title) : [action.where, closed ? '(aba fechada)' : null].filter(Boolean).join(' ');
    if (where) children.push({ type: 'text', style: 'faint', text: `onde: ${where}` });
    if (buttons.length) children.push({ type: 'row', children: buttons });
  }
  return { state, block: { type: 'card', children } };
}

/** Os blocos da janela do gerente [key]: os cartões dos descendentes, quem precisa de você em cima. */
function panel(links, key, sessions) {
  const live = new Map(sessions.filter((s) => !s.exited).map((s) => [s.id, s]));
  const manager = links.nodes[key];
  const kids = links.subtree(key).slice(1).map((k) => {
    const node = links.nodes[k];
    return cardBlock({ node, session: live.get(node.tabId) || null, card: node.card || null }, live);
  });
  kids.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const count = (st) => kids.filter((c) => c.state === st).length;
  const color = colorOf(manager.color);
  return {
    title: `painel · ${bare(manager.name)}`,
    blocks: [
      {
        type: 'header',
        title: bare(manager.name),
        subtitle: `${count('needs_you')} precisa de você · ${count('working')} trabalhando · ${count('done')} pronto`,
        avatar: { shape: 'circle', color: color.hex, text: '' },
      },
      ...(kids.length ? kids.map((c) => c.block) : [{ type: 'text', style: 'dim', text: 'Nenhuma sessão ainda: as que este gerente abrir aparecem aqui.' }]),
    ],
  };
}

module.exports = { panel, stateOf, taskOf, STATES, MAX_BULLETS };
